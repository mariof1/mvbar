import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { parsePluginPackage, pluginUploadLimitBytes } from './package.js';

export const BUNDLED_MISSING_MUSIC_KEY = 'missing-music';
export const DEFAULT_PLUGIN_REGISTRY_URL = 'https://raw.githubusercontent.com/mariof1/mvbar-plugins/main/registry.json';

const REGISTRY_TIMEOUT_MS = 5_000;
const PACKAGE_TIMEOUT_MS = 20_000;
const REGISTRY_MAX_BYTES = 512 * 1024;
const REGISTRY_CACHE_MS = 5 * 60_000;

const BUNDLED_PLUGINS = {
  [BUNDLED_MISSING_MUSIC_KEY]: {
    filename: 'mvbar-missing-music.ndp',
  },
} as const;

type BundledPluginKey = keyof typeof BUNDLED_PLUGINS;

export type OfficialPluginDefinition = {
  key: string;
  id: string;
  name: string;
  version: string;
  description: string | null;
  filename: string;
  packageUrl: string | null;
  packageSha256: string;
  size: number;
  homepage: string | null;
  repositoryUrl: string | null;
  source: 'repository' | 'bundled';
};

type RegistryPlugin = Omit<OfficialPluginDefinition, 'packageSha256' | 'repositoryUrl' | 'source'> & {
  packageUrl: string;
  sha256: string;
};

type PluginRegistry = {
  schemaVersion: 1;
  repository: string | null;
  plugins: RegistryPlugin[];
};

let registryCache: { url: string; expiresAt: number; registry: PluginRegistry } | null = null;

function requiredString(value: unknown, label: string, max = 500) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  if (value.length > max) throw new Error(`${label} is too long`);
  return value.trim();
}

function optionalHttpsUrl(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null;
  const raw = requiredString(value, label, 2_000);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  return url;
}

function registryUrl() {
  const configured = process.env.PLUGIN_REGISTRY_URL;
  if (configured !== undefined && !configured.trim()) return null;
  return optionalHttpsUrl(configured ?? DEFAULT_PLUGIN_REGISTRY_URL, 'Plugin registry URL');
}

async function fetchLimited(url: URL, maximumBytes: number, timeoutMs: number) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json, application/octet-stream', 'User-Agent': 'MVBar-PluginRegistry/1.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Plugin repository request failed (${response.status})`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error('Plugin repository response is too large');
  if (!response.body) throw new Error('Plugin repository returned an empty response');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Plugin repository response is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

export function parsePluginRegistry(value: unknown, sourceUrl: URL): PluginRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plugin registry must be an object');
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1) throw new Error('Unsupported plugin registry schema');
  if (!Array.isArray(input.plugins) || input.plugins.length > 100) throw new Error('Plugin registry has an invalid plugin list');
  const repository = optionalHttpsUrl(input.repository, 'Plugin repository URL')?.toString() ?? null;
  const keys = new Set<string>();
  const ids = new Set<string>();
  const plugins = input.plugins.map((raw, index): RegistryPlugin => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Plugin registry entry ${index + 1} must be an object`);
    const entry = raw as Record<string, unknown>;
    const key = requiredString(entry.key, 'Plugin key', 64);
    const id = requiredString(entry.id, 'Plugin id', 200);
    const filename = requiredString(entry.filename, 'Plugin filename', 255);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) throw new Error(`Plugin registry key ${key} is invalid`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id)) throw new Error(`Plugin registry id ${id} is invalid`);
    if (filename !== filename.split('/').pop() || !filename.toLowerCase().endsWith('.ndp')) throw new Error(`Plugin filename for ${key} is invalid`);
    if (keys.has(key) || ids.has(id)) throw new Error('Plugin registry keys and ids must be unique');
    keys.add(key);
    ids.add(id);
    const packageUrl = optionalHttpsUrl(entry.packageUrl, `Package URL for ${key}`);
    if (!packageUrl || packageUrl.origin !== sourceUrl.origin) throw new Error(`Package URL for ${key} must use the registry origin`);
    const sha256 = requiredString(entry.sha256, `Checksum for ${key}`, 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Checksum for ${key} is invalid`);
    const size = Number(entry.size);
    if (!Number.isSafeInteger(size) || size < 100 || size > pluginUploadLimitBytes()) throw new Error(`Package size for ${key} is invalid`);
    return {
      key,
      id,
      name: requiredString(entry.name, 'Plugin name', 200),
      version: requiredString(entry.version, 'Plugin version', 100),
      description: typeof entry.description === 'string' ? entry.description.slice(0, 2_000) : null,
      filename,
      packageUrl: packageUrl.toString(),
      sha256,
      size,
      homepage: optionalHttpsUrl(entry.homepage, `Homepage for ${key}`)?.toString() ?? null,
    };
  });
  return { schemaVersion: 1, repository, plugins };
}

async function fetchPluginRegistry() {
  const url = registryUrl();
  if (!url) return null;
  if (registryCache && registryCache.url === url.toString() && registryCache.expiresAt > Date.now()) return registryCache.registry;
  const buffer = await fetchLimited(url, REGISTRY_MAX_BYTES, REGISTRY_TIMEOUT_MS);
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('Plugin registry returned invalid JSON');
  }
  const registry = parsePluginRegistry(value, url);
  registryCache = { url: url.toString(), expiresAt: Date.now() + REGISTRY_CACHE_MS, registry };
  return registry;
}

async function readBundledPluginPackage(key: BundledPluginKey) {
  const definition = BUNDLED_PLUGINS[key];
  const packageUrl = new URL(`./bundled/${definition.filename}`, import.meta.url);
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(packageUrl);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    buffer = await fs.readFile(new URL(`../../assets/plugins/${definition.filename}`, import.meta.url));
  }
  const parsed = await parsePluginPackage(buffer, definition.filename);
  return { key, buffer, parsed, source: 'bundled' as const };
}

async function bundledPluginDefinitions() {
  return Promise.all((Object.keys(BUNDLED_PLUGINS) as BundledPluginKey[]).map(async (key): Promise<OfficialPluginDefinition> => {
    const { parsed, buffer } = await readBundledPluginPackage(key);
    return {
      key,
      id: parsed.id,
      name: parsed.manifest.name,
      version: parsed.manifest.version,
      description: parsed.manifest.description ?? null,
      filename: parsed.filename,
      packageUrl: null,
      packageSha256: parsed.packageSha256,
      size: buffer.length,
      homepage: parsed.manifest.homepage ?? parsed.manifest.website ?? null,
      repositoryUrl: null,
      source: 'bundled',
    };
  }));
}

export async function listBundledPluginPackages() {
  const bundled = await bundledPluginDefinitions();
  let registry: PluginRegistry | null = null;
  try {
    registry = await fetchPluginRegistry();
  } catch {
    // The bundled package keeps installation available when GitHub or DNS is unavailable.
  }
  const merged = new Map(bundled.map((plugin) => [plugin.key, plugin]));
  for (const plugin of registry?.plugins ?? []) {
    merged.set(plugin.key, {
      ...plugin,
      packageSha256: plugin.sha256,
      repositoryUrl: registry?.repository ?? null,
      source: 'repository',
    });
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function isBundledPluginKey(value: string) {
  return (await listBundledPluginPackages()).some((plugin) => plugin.key === value);
}

export async function getBundledPluginPackage(key: string, options: { bundledOnly?: boolean } = {}) {
  if (!options.bundledOnly) {
    const definition = (await listBundledPluginPackages()).find((plugin) => plugin.key === key);
    if (definition?.source === 'repository' && definition.packageUrl) {
      const buffer = await fetchLimited(new URL(definition.packageUrl), pluginUploadLimitBytes(), PACKAGE_TIMEOUT_MS);
      if (buffer.length !== definition.size) throw new Error('Downloaded plugin size does not match the registry');
      const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
      if (checksum !== definition.packageSha256) throw new Error('Downloaded plugin checksum does not match the registry');
      const parsed = await parsePluginPackage(buffer, definition.filename);
      if (parsed.id !== definition.id || parsed.manifest.version !== definition.version) {
        throw new Error('Downloaded plugin identity does not match the registry');
      }
      return { key, buffer, parsed, source: 'repository' as const };
    }
  }
  if (!Object.hasOwn(BUNDLED_PLUGINS, key)) throw new Error('Official plugin not found');
  return readBundledPluginPackage(key as BundledPluginKey);
}

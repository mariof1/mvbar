import crypto from 'node:crypto';
import path from 'node:path';
import unzipper from 'unzipper';
import type { NdpManifest, ParsedPluginPackage, PluginAction } from './types.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_PACKAGE_MB = 50;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }
  return value;
}

function slug(value: string) {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 96);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validateSchema(schema: unknown, label: string) {
  const record = objectRecord(schema);
  if (!record) throw new Error(`${label} must be an object`);
  if (record.type !== undefined && record.type !== 'object') throw new Error(`${label}.type must be object`);
  if (record.additionalProperties !== undefined && typeof record.additionalProperties !== 'boolean') {
    throw new Error(`${label}.additionalProperties must be true or false`);
  }
  if (record.required !== undefined) {
    if (!Array.isArray(record.required) || record.required.length > 100 || record.required.some((key) => typeof key !== 'string')) {
      throw new Error(`${label}.required must be an array of at most 100 strings`);
    }
  }
  if (record.properties === undefined) return;
  const properties = objectRecord(record.properties);
  if (!properties || Object.keys(properties).length > 100) throw new Error(`${label}.properties must be an object with at most 100 entries`);
  for (const [key, rawProperty] of Object.entries(properties)) {
    if (!key || key.length > 128) throw new Error(`${label}.properties contains an invalid key`);
    const property = objectRecord(rawProperty);
    if (!property) throw new Error(`${label}.properties.${key} must be an object`);
    if (property.type !== undefined && !['string', 'integer', 'number', 'boolean'].includes(String(property.type))) {
      throw new Error(`${label}.properties.${key}.type is unsupported`);
    }
    if (property.enum !== undefined && (!Array.isArray(property.enum) || property.enum.length > 100)) {
      throw new Error(`${label}.properties.${key}.enum must contain at most 100 values`);
    }
    for (const textField of ['title', 'description', 'format']) {
      const text = property[textField];
      if (text !== undefined && (typeof text !== 'string' || text.length > 4000)) {
        throw new Error(`${label}.properties.${key}.${textField} is invalid`);
      }
    }
    for (const numberField of ['minimum', 'maximum']) {
      const number = property[numberField];
      if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number))) {
        throw new Error(`${label}.properties.${key}.${numberField} must be a finite number`);
      }
    }
  }
}

function validateAction(action: PluginAction, index: number) {
  if (!action || typeof action !== 'object') throw new Error(`mvbar.actions[${index}] must be an object`);
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(action.id ?? '')) {
    throw new Error(`mvbar.actions[${index}].id is invalid`);
  }
  if (typeof action.name !== 'string' || !action.name.trim()) {
    throw new Error(`mvbar.actions[${index}].name is required`);
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(action.export ?? '')) {
    throw new Error(`mvbar.actions[${index}].export is invalid`);
  }
  if (action.inputSchema !== undefined) validateSchema(action.inputSchema, `mvbar.actions[${index}].inputSchema`);
}

function validateManifest(value: unknown): NdpManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('manifest.json must contain a JSON object');
  }
  const manifest = value as NdpManifest;
  for (const field of ['name', 'author', 'version'] as const) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim() || manifest[field].length > 256) {
      throw new Error(`manifest.json field ${field} is required`);
    }
  }
  for (const field of ['description', 'homepage', 'website'] as const) {
    if (manifest[field] !== undefined && (typeof manifest[field] !== 'string' || manifest[field]!.length > 4000)) {
      throw new Error(`manifest.json field ${field} is invalid`);
    }
  }
  for (const field of ['homepage', 'website'] as const) {
    const value = manifest[field]?.trim();
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`manifest.json field ${field} must be an absolute HTTP(S) URL`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`manifest.json field ${field} must use HTTP(S)`);
  }
  if (manifest.id !== undefined && !/^[a-zA-Z][a-zA-Z0-9._-]{0,95}$/.test(manifest.id)) {
    throw new Error('manifest.json id must start with a letter and contain only letters, numbers, dot, dash, or underscore');
  }
  if (manifest.config !== undefined) {
    if (!objectRecord(manifest.config)) throw new Error('config must be an object');
    if (manifest.config.schema !== undefined) validateSchema(manifest.config.schema, 'config.schema');
  }
  const actions = manifest.mvbar?.actions;
  if (actions !== undefined) {
    if (!Array.isArray(actions) || actions.length > 32) throw new Error('mvbar.actions must be an array of at most 32 actions');
    actions.forEach(validateAction);
  }
  if (manifest.mvbar?.extension !== undefined) {
    const extension = objectRecord(manifest.mvbar.extension);
    if (!extension || typeof extension.type !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(extension.type)) {
      throw new Error('mvbar.extension.type is invalid');
    }
    if (extension.version !== undefined && (!Number.isInteger(extension.version) || Number(extension.version) < 1)) {
      throw new Error('mvbar.extension.version must be a positive integer');
    }
  }
  const hosts = manifest.permissions?.http?.requiredHosts;
  if (hosts !== undefined) {
    if (!Array.isArray(hosts) || hosts.length > 64 || hosts.some((host) => typeof host !== 'string' || host.length > 253)) {
      throw new Error('permissions.http.requiredHosts is invalid');
    }
  }
  return manifest;
}

export function pluginUploadLimitBytes() {
  const configured = Number(process.env.PLUGIN_MAX_UPLOAD_MB ?? DEFAULT_MAX_PACKAGE_MB);
  const mb = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_PACKAGE_MB;
  return Math.floor(mb * 1024 * 1024);
}

export function packageFilenameForId(id: string) {
  return `${id}.ndp`;
}

export async function parsePluginPackage(buffer: Buffer, filename: string): Promise<ParsedPluginPackage> {
  if (!filename.toLowerCase().endsWith('.ndp')) throw new Error('Plugin packages must use the .ndp extension');
  if (buffer.length === 0) throw new Error('Plugin package is empty');
  if (buffer.length > pluginUploadLimitBytes()) throw new Error('Plugin package exceeds the configured upload limit');

  let archive: unzipper.CentralDirectory;
  try {
    archive = await unzipper.Open.buffer(buffer);
  } catch {
    throw new Error('Plugin package is not a valid ZIP-based .ndp archive');
  }

  const manifestEntries = archive.files.filter((entry) => entry.path === 'manifest.json' && entry.type === 'File');
  const wasmEntries = archive.files.filter((entry) => entry.path === 'plugin.wasm' && entry.type === 'File');
  if (manifestEntries.length !== 1 || wasmEntries.length !== 1) {
    throw new Error('Plugin package must contain exactly one manifest.json and one plugin.wasm at its root');
  }
  const manifestEntry = manifestEntries[0];
  const wasmEntry = wasmEntries[0];
  if (manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES) throw new Error('Plugin manifest is too large');
  if (wasmEntry.uncompressedSize > pluginUploadLimitBytes()) throw new Error('Plugin WebAssembly module is too large');

  let manifest: NdpManifest;
  try {
    manifest = validateManifest(JSON.parse((await manifestEntry.buffer()).toString('utf8')));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('manifest.json is not valid JSON');
    throw error;
  }
  const id = manifest.id ?? slug(`${manifest.author}.${manifest.name}`);
  if (!id) throw new Error('Unable to derive a plugin id; add an id to manifest.json');

  const wasm = await wasmEntry.buffer();
  if (wasm.length < 8 || wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) {
    throw new Error('plugin.wasm is not a WebAssembly binary');
  }

  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(Uint8Array.from(wasm));
  } catch (error) {
    throw new Error(`plugin.wasm could not be compiled: ${error instanceof Error ? error.message : String(error)}`);
  }
  const exports = WebAssembly.Module.exports(module)
    .filter((entry) => entry.kind === 'function')
    .map((entry) => entry.name)
    .sort();
  if (exports.length === 0) throw new Error('plugin.wasm does not export any functions');

  return {
    id,
    filename: path.basename(filename),
    manifest,
    wasm,
    exports,
    packageSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    permissionFingerprint: crypto
      .createHash('sha256')
      .update(JSON.stringify(stableValue(manifest.permissions ?? {})))
      .digest('hex'),
  };
}

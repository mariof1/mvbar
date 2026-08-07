import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import createPlugin, { type CurrentPlugin, type Plugin } from '@extism/extism';
import { db } from '../db.js';
import logger from '../logger.js';
import { getPluginPackage, getPluginRow, pluginDataDirectory, pluginsEnabledGlobally } from './registry.js';
import type { NdpManifest, PluginDbRow, PluginLogEntry } from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MEMORY_MB = 64;
const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_HTTP_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_KV_BYTES = 1024 * 1024;

let activeCalls = 0;
const callQueue: Array<() => void> = [];

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function acquireCallSlot() {
  const max = positiveInteger(process.env.PLUGIN_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY);
  return new Promise<() => void>((resolve) => {
    const enter = () => {
      activeCalls += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeCalls -= 1;
        callQueue.shift()?.();
      });
    };
    if (activeCalls < max) enter();
    else callQueue.push(enter);
  });
}

function stringifyConfigValue(value: unknown) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

export function effectivePluginConfig(row: Pick<PluginDbRow, 'manifest' | 'config'>) {
  const config: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(row.manifest.config?.schema?.properties ?? {})) {
    if (property.default !== undefined) config[key] = property.default;
  }
  Object.assign(config, row.config ?? {});
  return config;
}

function extismConfig(row: Pick<PluginDbRow, 'manifest' | 'config'>) {
  return Object.fromEntries(
    Object.entries(effectivePluginConfig(row)).map(([key, value]) => [key, stringifyConfigValue(value)])
  );
}

function pluginLogger(pluginId: string, entries: PluginLogEntry[]): Console {
  const capture = (level: PluginLogEntry['level'], args: unknown[]) => {
    const message = args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ').slice(0, 2000);
    entries.push({ level, message });
    if (entries.length > 100) entries.shift();
    if (level === 'error') logger.error('plugins', `[${pluginId}] ${message}`);
    else if (level === 'warn') logger.warn('plugins', `[${pluginId}] ${message}`);
    else if (level === 'info') logger.info('plugins', `[${pluginId}] ${message}`);
  };
  return {
    trace: (...args: unknown[]) => capture('trace', args),
    debug: (...args: unknown[]) => capture('debug', args),
    info: (...args: unknown[]) => capture('info', args),
    warn: (...args: unknown[]) => capture('warn', args),
    error: (...args: unknown[]) => capture('error', args),
  } as unknown as Console;
}

function requestJson<T>(cp: CurrentPlugin, offset: bigint): T {
  const input = cp.read(offset);
  if (!input) throw new Error('Plugin supplied an invalid host-function request');
  return input.json() as T;
}

function responseJson(cp: CurrentPlugin, value: unknown) {
  return cp.store(JSON.stringify(value));
}

function permissionError(cp: CurrentPlugin, permission: string) {
  return responseJson(cp, { error: `Plugin did not declare the ${permission} permission` });
}

function normalizeHostnamePattern(value: string) {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function hostMatchesPattern(hostname: string, pattern: string) {
  const host = normalizeHostnamePattern(hostname);
  const allowed = normalizeHostnamePattern(pattern);
  if (allowed === '*') return true;
  if (allowed.startsWith('*.')) {
    const suffix = allowed.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === allowed;
}

function ipIsPrivate(address: string) {
  const family = net.isIP(address);
  if (family === 4) {
    const bytes = address.split('.').map(Number);
    return bytes[0] === 10
      || bytes[0] === 127
      || (bytes[0] === 100 && bytes[1] >= 64 && bytes[1] <= 127)
      || (bytes[0] === 169 && bytes[1] === 254)
      || (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31)
      || (bytes[0] === 192 && bytes[1] === 168)
      || (bytes[0] === 198 && (bytes[1] === 18 || bytes[1] === 19))
      || bytes[0] === 0
      || bytes[0] >= 224;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1'
      || normalized === '::'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith('::ffff:');
  }
  return false;
}

async function validatePluginUrl(url: URL, manifest: NdpManifest) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs are allowed');
  if (url.username || url.password) throw new Error('Credentials in plugin request URLs are not allowed');
  const httpPermission = manifest.permissions?.http;
  if (!httpPermission) throw new Error('Plugin did not declare the http permission');
  const patterns = (httpPermission.requiredHosts ?? []).filter(Boolean);
  if (patterns.length > 0) {
    if (!patterns.some((pattern) => hostMatchesPattern(url.hostname, pattern))) {
      throw new Error(`Host ${url.hostname} is not listed in permissions.http.requiredHosts`);
    }
    return;
  }
  if (url.hostname.toLowerCase() === 'localhost') throw new Error('Private hosts require an explicit requiredHosts entry');
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => ipIsPrivate(entry.address))) {
    throw new Error('Private hosts require an explicit requiredHosts entry');
  }
}

async function readLimitedResponse(response: Response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_HTTP_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Plugin HTTP response exceeded 10 MB');
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

type PluginHttpRequest = {
  request?: {
    method?: string;
    url?: string;
    headers?: Record<string, string> | null;
    body?: string | null;
    timeoutMs?: number;
    noFollowRedirects?: boolean;
  };
};

async function pluginHttpSend(manifest: NdpManifest, requestEnvelope: PluginHttpRequest) {
  const request = requestEnvelope.request;
  if (!request || typeof request.url !== 'string') throw new Error('Plugin HTTP request is missing a URL');
  const method = (request.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`HTTP method ${method} is not allowed`);
  const timeoutMs = Math.min(Math.max(Number(request.timeoutMs) || 10_000, 100), 60_000);
  let currentUrl = new URL(request.url);
  let redirects = 0;
  const body = request.body ? Buffer.from(request.body, 'base64') : undefined;
  if (body && body.length > 10 * 1024 * 1024) throw new Error('Plugin HTTP request body exceeded 10 MB');

  while (true) {
    await validatePluginUrl(currentUrl, manifest);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(currentUrl, {
        method,
        headers: request.headers ?? undefined,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'manual',
        signal: controller.signal,
      });
      const location = response.headers.get('location');
      if (!request.noFollowRedirects && location && [301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= 5) throw new Error('Plugin HTTP redirect limit exceeded');
        currentUrl = new URL(location, currentUrl);
        redirects += 1;
        continue;
      }
      const responseBody = await readLimitedResponse(response);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      return {
        statusCode: response.status,
        headers,
        body: responseBody.toString('base64'),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseByteSize(input: string | undefined) {
  if (!input) return DEFAULT_KV_BYTES;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?\s*$/i.exec(input);
  if (!match) return DEFAULT_KV_BYTES;
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
  };
  return Math.min(Math.floor(Number(match[1]) * (multipliers[(match[2] ?? 'b').toLowerCase()] ?? 1)), 100 * 1024 * 1024);
}

function validateKvKey(key: unknown) {
  if (typeof key !== 'string' || Buffer.byteLength(key) === 0 || Buffer.byteLength(key) > 256) {
    throw new Error('KV key must contain between 1 and 256 UTF-8 bytes');
  }
  return key;
}

function kvValue(value: unknown) {
  if (typeof value !== 'string') throw new Error('KV value must be base64 encoded');
  return Buffer.from(value, 'base64');
}

async function enforceKvLimit(pluginId: string, value: Buffer, previousKey?: string) {
  const row = await getPluginRow(pluginId);
  const limit = parseByteSize(row?.manifest.permissions?.kvstore?.maxSize);
  const result = await db().query<{ bytes: string }>(
    `select coalesce(sum(octet_length(value)), 0)::text as bytes
       from plugin_kv
      where plugin_id=$1
        and (expires_at is null or expires_at > now())
        and ($2::text is null or key <> $2)`,
    [pluginId, previousKey ?? null]
  );
  if (Number(result.rows[0]?.bytes ?? 0) + value.length > limit) throw new Error(`Plugin KV storage limit of ${limit} bytes exceeded`);
}

function createHostFunctions(row: PluginDbRow) {
  const config = extismConfig(row);
  const hasConfig = Boolean(row.manifest.permissions?.config);
  const hasKv = Boolean(row.manifest.permissions?.kvstore);
  return {
    'extism:host/user': {
      config_get: (cp: CurrentPlugin, offset: bigint) => {
        if (!hasConfig) return responseJson(cp, { exists: false });
        const { key } = requestJson<{ key?: string }>(cp, offset);
        const exists = typeof key === 'string' && Object.hasOwn(config, key);
        return responseJson(cp, { value: exists ? config[key as string] : '', exists });
      },
      config_getint: (cp: CurrentPlugin, offset: bigint) => {
        if (!hasConfig) return responseJson(cp, { exists: false });
        const { key } = requestJson<{ key?: string }>(cp, offset);
        const parsed = typeof key === 'string' ? Number.parseInt(config[key] ?? '', 10) : Number.NaN;
        return responseJson(cp, { value: Number.isFinite(parsed) ? parsed : 0, exists: Number.isFinite(parsed) });
      },
      config_keys: (cp: CurrentPlugin, offset: bigint) => {
        if (!hasConfig) return responseJson(cp, { keys: [] });
        const { prefix } = requestJson<{ prefix?: string }>(cp, offset);
        const wanted = typeof prefix === 'string' ? prefix : '';
        return responseJson(cp, { keys: Object.keys(config).filter((key) => key.startsWith(wanted)).sort() });
      },
      http_send: async (cp: CurrentPlugin, offset: bigint) => {
        if (!row.manifest.permissions?.http) return permissionError(cp, 'http');
        try {
          return responseJson(cp, { result: await pluginHttpSend(row.manifest, requestJson<PluginHttpRequest>(cp, offset)) });
        } catch (error) {
          return responseJson(cp, { error: error instanceof Error ? error.message : String(error) });
        }
      },
      kvstore_set: async (cp: CurrentPlugin, offset: bigint) => {
        if (!hasKv) return permissionError(cp, 'kvstore');
        try {
          const request = requestJson<{ key?: unknown; value?: unknown }>(cp, offset);
          const key = validateKvKey(request.key);
          const value = kvValue(request.value);
          await enforceKvLimit(row.id, value, key);
          await db().query(
            `insert into plugin_kv(plugin_id,key,value,expires_at,updated_at) values($1,$2,$3,null,now())
             on conflict(plugin_id,key) do update set value=excluded.value, expires_at=null, updated_at=now()`,
            [row.id, key, value]
          );
          return responseJson(cp, {});
        } catch (error) {
          return responseJson(cp, { error: error instanceof Error ? error.message : String(error) });
        }
      },
      kvstore_setwithttl: async (cp: CurrentPlugin, offset: bigint) => {
        if (!hasKv) return permissionError(cp, 'kvstore');
        try {
          const request = requestJson<{ key?: unknown; value?: unknown; ttlSeconds?: unknown }>(cp, offset);
          const key = validateKvKey(request.key);
          const value = kvValue(request.value);
          const ttl = Number(request.ttlSeconds);
          if (!Number.isInteger(ttl) || ttl <= 0 || ttl > 365 * 24 * 60 * 60) throw new Error('KV TTL is invalid');
          await enforceKvLimit(row.id, value, key);
          await db().query(
            `insert into plugin_kv(plugin_id,key,value,expires_at,updated_at)
             values($1,$2,$3,now() + ($4::text || ' seconds')::interval,now())
             on conflict(plugin_id,key) do update set value=excluded.value, expires_at=excluded.expires_at, updated_at=now()`,
            [row.id, key, value, ttl]
          );
          return responseJson(cp, {});
        } catch (error) {
          return responseJson(cp, { error: error instanceof Error ? error.message : String(error) });
        }
      },
      kvstore_get: async (cp: CurrentPlugin, offset: bigint) => {
        if (!hasKv) return permissionError(cp, 'kvstore');
        try {
          const key = validateKvKey(requestJson<{ key?: unknown }>(cp, offset).key);
          const result = await db().query<{ value: Buffer }>(
            'select value from plugin_kv where plugin_id=$1 and key=$2 and (expires_at is null or expires_at > now())',
            [row.id, key]
          );
          return responseJson(cp, result.rows[0] ? { value: result.rows[0].value.toString('base64'), exists: true } : { exists: false });
        } catch (error) {
          return responseJson(cp, { error: error instanceof Error ? error.message : String(error) });
        }
      },
      kvstore_getmany: async (cp: CurrentPlugin, offset: bigint) => {
        if (!hasKv) return permissionError(cp, 'kvstore');
        try {
          const requested = requestJson<{ keys?: unknown }>(cp, offset).keys;
          if (!Array.isArray(requested) || requested.length > 200) throw new Error('KV keys must be an array of at most 200 entries');
          const keys = requested.map(validateKvKey);
          const result = await db().query<{ key: string; value: Buffer }>(
            'select key,value from plugin_kv where plugin_id=$1 and key=any($2::text[]) and (expires_at is null or expires_at > now())',
            [row.id, keys]
          );
          return responseJson(cp, { values: Object.fromEntries(result.rows.map((entry) => [entry.key, entry.value.toString('base64')])) });
        } catch (error) {
          return responseJson(cp, { error: error instanceof Error ? error.message : String(error) });
        }
      },
      kvstore_has: async (cp: CurrentPlugin, offset: bigint) => {
        if (!hasKv) return permissionError(cp, 'kvstore');
        try {
          const key = validateKvKey(requestJson<{ key?: unknown }>(cp, offset).key);
          const result = await db().query(
            'select 1 from plugin_kv where plugin_id=$1 and key=$2 and (expires_at is null or expires_at > now())',
            [row.id, key]
          );
          return responseJson(cp, { exists: result.rowCount === 1 });
        } catch (error) {
          return responseJson(cp, { error: error instanceof Error ? error.message : String(error) });
        }
      },
      kvstore_list: async (cp: CurrentPlugin, offset: bigint) => {
        if (!hasKv) return permissionError(cp, 'kvstore');
        try {
          const prefix = requestJson<{ prefix?: unknown }>(cp, offset).prefix;
          if (typeof prefix !== 'string') throw new Error('KV prefix must be a string');
          const result = await db().query<{ key: string }>(
            `select key from plugin_kv
              where plugin_id=$1 and key like replace(replace($2, '\\', '\\\\'), '%', '\\%') || '%' escape '\\'
                and (expires_at is null or expires_at > now()) order by key limit 1000`,
            [row.id, prefix.replace(/_/g, '\\_')]
          );
          return responseJson(cp, { keys: result.rows.map((entry) => entry.key) });
        } catch (error) {
          return responseJson(cp, { error: error instanceof Error ? error.message : String(error) });
        }
      },
      kvstore_delete: async (cp: CurrentPlugin, offset: bigint) => {
        if (!hasKv) return permissionError(cp, 'kvstore');
        try {
          const key = validateKvKey(requestJson<{ key?: unknown }>(cp, offset).key);
          await db().query('delete from plugin_kv where plugin_id=$1 and key=$2', [row.id, key]);
          return responseJson(cp, {});
        } catch (error) {
          return responseJson(cp, { error: error instanceof Error ? error.message : String(error) });
        }
      },
      kvstore_deletebyprefix: async (cp: CurrentPlugin, offset: bigint) => {
        if (!hasKv) return permissionError(cp, 'kvstore');
        try {
          const prefix = requestJson<{ prefix?: unknown }>(cp, offset).prefix;
          if (typeof prefix !== 'string' || !prefix) throw new Error('KV delete prefix must not be empty');
          const result = await db().query(
            `delete from plugin_kv where plugin_id=$1
              and key like replace(replace($2, '\\', '\\\\'), '%', '\\%') || '%' escape '\\'`,
            [row.id, prefix.replace(/_/g, '\\_')]
          );
          return responseJson(cp, { deletedCount: result.rowCount ?? 0 });
        } catch (error) {
          return responseJson(cp, { error: error instanceof Error ? error.message : String(error) });
        }
      },
      kvstore_getstorageused: async (cp: CurrentPlugin) => {
        if (!hasKv) return permissionError(cp, 'kvstore');
        const result = await db().query<{ bytes: string }>(
          'select coalesce(sum(octet_length(value)),0)::text as bytes from plugin_kv where plugin_id=$1 and (expires_at is null or expires_at > now())',
          [row.id]
        );
        return responseJson(cp, { bytes: Number(result.rows[0]?.bytes ?? 0) });
      },
    },
  };
}

async function createRuntime(row: PluginDbRow, entries: PluginLogEntry[]) {
  const parsed = await getPluginPackage(row);
  const memoryMb = positiveInteger(process.env.PLUGIN_MEMORY_MB, DEFAULT_MEMORY_MB);
  const timeoutMs = positiveInteger(process.env.PLUGIN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const major = Number(process.versions.node.split('.')[0]);
  const execArgv = major < 20 ? ['--experimental-global-webcrypto'] : ['--disable-warning=ExperimentalWarning'];
  let allowedPaths: Record<string, string> | undefined;
  if (row.manifest.permissions?.storage) {
    const hostPath = path.resolve(pluginDataDirectory(row.id));
    await fs.mkdir(hostPath, { recursive: true, mode: 0o700 });
    allowedPaths = { '/plugin-data': hostPath };
  }
  const plugin = await createPlugin({ wasm: [{ data: Uint8Array.from(parsed.wasm) }] }, {
    useWasi: true,
    runInWorker: true,
    timeoutMs,
    config: row.manifest.permissions?.config ? extismConfig(row) : {},
    functions: createHostFunctions(row),
    allowedPaths,
    memory: {
      maxPages: Math.max(16, Math.floor(memoryMb * 1024 * 1024 / 65_536)),
      maxHttpResponseBytes: MAX_HTTP_RESPONSE_BYTES,
      maxVarBytes: Math.min(memoryMb * 1024 * 1024, 16 * 1024 * 1024),
    },
    enableWasiOutput: false,
    logger: pluginLogger(row.id, entries),
    // Extism's worker transport can emit guest logs before its ready message;
    // keep guest logging silent so initialization remains deterministic.
    logLevel: 'silent',
    nodeWorkerArgs: { name: `mvbar-plugin-${row.id}`, execArgv },
  });
  return { plugin, parsed };
}

async function recordRun(row: PluginDbRow, exportName: string, ok: boolean, started: number, error: string | null, logs: PluginLogEntry[]) {
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  await db().query(
    'insert into plugin_runs(plugin_id,export_name,ok,duration_ms,error,logs) values($1,$2,$3,$4,$5,$6)',
    [row.id, exportName, ok, durationMs, error, logs]
  ).catch(() => undefined);
  await db().query(
    'update plugins set last_loaded_at=now(), last_error=$2 where id=$1',
    [row.id, error]
  ).catch(() => undefined);
}

export async function inspectPlugin(id: string) {
  if (!pluginsEnabledGlobally()) throw new Error('Plugin execution is disabled by PLUGINS_ENABLED');
  const row = await getPluginRow(id);
  if (!row) throw new Error('Plugin not found');
  const release = await acquireCallSlot();
  const logs: PluginLogEntry[] = [];
  let plugin: Plugin | null = null;
  try {
    const runtime = await createRuntime(row, logs);
    plugin = runtime.plugin;
    return {
      exports: (await plugin.getExports()).filter((entry) => entry.kind === 'function').map((entry) => entry.name).sort(),
      imports: (await plugin.getImports()).map((entry) => `${entry.module}.${entry.name}`).sort(),
      logs,
    };
  } finally {
    if (plugin) await plugin.close().catch(() => undefined);
    release();
  }
}

export async function callPluginExport(id: string, exportName: string, input: unknown) {
  if (!pluginsEnabledGlobally()) throw new Error('Plugin execution is disabled by PLUGINS_ENABLED');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(exportName)) throw new Error('Invalid plugin export name');
  const row = await getPluginRow(id);
  if (!row) throw new Error('Plugin not found');
  if (!row.enabled) throw new Error('Plugin is disabled');
  const release = await acquireCallSlot();
  const logs: PluginLogEntry[] = [];
  const started = performance.now();
  let plugin: Plugin | null = null;
  try {
    const runtime = await createRuntime(row, logs);
    plugin = runtime.plugin;
    if (!(await plugin.functionExists(exportName))) throw new Error(`Plugin does not export ${exportName}`);
    const output = await plugin.call(exportName, JSON.stringify(input ?? {}));
    const text = output?.text() ?? '';
    const value = text ? JSON.parse(text) as unknown : null;
    await recordRun(row, exportName, true, started, null, logs);
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordRun(row, exportName, false, started, message.slice(0, 4000), logs);
    throw error;
  } finally {
    if (plugin) await plugin.close().catch(() => undefined);
    release();
  }
}

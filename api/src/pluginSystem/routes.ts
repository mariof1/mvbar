import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { audit, db } from '../db.js';
import { broadcastToAdmins } from '../websocket.js';
import { pluginUploadLimitBytes } from './package.js';
import {
  getPluginPackage,
  getPluginRow,
  installPluginPackage,
  pluginPackagePath,
  pluginsEnabledGlobally,
  removePluginPackage,
  rescanPlugins,
} from './registry.js';
import { callPluginExport, effectivePluginConfig, inspectPlugin } from './runtime.js';
import type { JsonSchemaProperty, NdpManifest, PluginAction, PluginDbRow } from './types.js';
import { MISSING_MUSIC_PLUGIN_ID, validateMissingMusicConfig } from './missingMusic.js';

function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) {
    reply.code(401).send({ ok: false, error: 'Authentication required' });
    return false;
  }
  if (req.user.role !== 'admin') {
    reply.code(403).send({ ok: false, error: 'Administrator access required' });
    return false;
  }
  return true;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function secretConfigKeys(manifest: NdpManifest) {
  const secrets = new Set<string>();
  for (const [key, property] of Object.entries(manifest.config?.schema?.properties ?? {})) {
    if (property.format === 'password' || /(password|secret|token|api.?key)/i.test(`${key} ${property.title ?? ''}`)) secrets.add(key);
  }
  const pending: unknown[] = [manifest.config?.uiSchema];
  const visited = new WeakSet<object>();
  let inspected = 0;
  while (pending.length && inspected < 10_000) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    inspected += 1;
    const record = value as Record<string, unknown>;
    if (record.type === 'Control' && typeof record.scope === 'string') {
      const match = /^#\/properties\/([^/]+)$/.exec(record.scope);
      const options = record.options as Record<string, unknown> | undefined;
      if (match && options?.format === 'password') secrets.add(match[1]);
    }
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) pending.push(...child);
      else if (child && typeof child === 'object') pending.push(child);
    }
  }
  return secrets;
}

function permissionSummary(manifest: NdpManifest) {
  const permissions = manifest.permissions ?? {};
  return Object.entries(permissions).map(([key, raw]) => {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    let detail: string | undefined;
    if (key === 'http') {
      const hosts = Array.isArray(value.requiredHosts) ? value.requiredHosts.filter((host): host is string => typeof host === 'string') : [];
      detail = hosts.length ? `Hosts: ${hosts.join(', ')}` : 'Public internet only; private hosts blocked';
    } else if (key === 'kvstore' && typeof value.maxSize === 'string') {
      detail = `Maximum storage: ${value.maxSize}`;
    } else if (key === 'storage') {
      detail = 'Read/write access to this plugin’s isolated data directory';
    } else if (key === 'catalog') {
      detail = 'Read-only access to MusicBrainz identifiers and titles in the enabled music libraries';
    } else if (key === 'requests') {
      detail = 'Create request records and hand approved requests to the configured external service';
    }
    return {
      key,
      reason: typeof value.reason === 'string' ? value.reason : null,
      detail: detail ?? null,
      broad: key === 'http' && Array.isArray(value.requiredHosts) && value.requiredHosts.includes('*'),
      supported: ['config', 'http', 'kvstore', 'storage', 'catalog', 'requests'].includes(key),
    };
  });
}

async function serializePlugin(row: PluginDbRow) {
  let present = false;
  let exports: string[] = [];
  try {
    const parsed = await getPluginPackage(row);
    present = true;
    exports = parsed.exports;
  } catch {
    present = false;
  }
  const effective = effectivePluginConfig(row);
  const secrets = secretConfigKeys(row.manifest);
  const config = Object.fromEntries(Object.entries(effective).map(([key, value]) => [key, secrets.has(key) ? '' : value]));
  return {
    id: row.id,
    filename: row.filename,
    name: row.name,
    author: row.author,
    version: row.version,
    description: row.description,
    homepage: row.homepage,
    enabled: row.enabled && present && pluginsEnabledGlobally(),
    enabledInDatabase: row.enabled,
    present,
    packageSha256: row.package_sha256,
    permissionFingerprint: row.permission_fingerprint,
    permissions: permissionSummary(row.manifest),
    configSchema: row.manifest.config?.schema ?? null,
    config,
    configuredSecrets: Array.from(secrets).filter((key) => {
      const value = effective[key];
      return value !== undefined && value !== null && String(value).length > 0;
    }),
    actions: row.manifest.mvbar?.actions ?? [],
    exports,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    lastLoadedAt: row.last_loaded_at,
    lastError: present ? row.last_error : 'Plugin package is missing from the plugin directory',
  };
}

function validateProperty(key: string, property: JsonSchemaProperty, value: unknown) {
  if (property.enum && !property.enum.some((candidate) => Object.is(candidate, value))) throw new Error(`${key} must be one of the allowed values`);
  if (property.type === 'string' && typeof value !== 'string') throw new Error(`${key} must be a string`);
  if (property.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be true or false`);
  if (property.type === 'integer' && (!Number.isInteger(value) || typeof value !== 'number')) throw new Error(`${key} must be an integer`);
  if (property.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${key} must be a number`);
  if (typeof value === 'number' && property.minimum !== undefined && value < property.minimum) throw new Error(`${key} must be at least ${property.minimum}`);
  if (typeof value === 'number' && property.maximum !== undefined && value > property.maximum) throw new Error(`${key} must be at most ${property.maximum}`);
}

function validateObjectInput(
  input: unknown,
  schema: { properties?: Record<string, JsonSchemaProperty>; required?: string[]; additionalProperties?: boolean } | undefined,
  existing: Record<string, unknown> = {},
  secrets: Set<string> = new Set()
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be a JSON object');
  const supplied = input as Record<string, unknown>;
  if (Object.keys(supplied).length > 100) throw new Error('Too many configuration values');
  const properties = schema?.properties ?? {};
  const output: Record<string, unknown> = schema?.additionalProperties ? { ...existing } : {};
  for (const [key, value] of Object.entries(supplied)) {
    const property = properties[key];
    if (!property && schema?.additionalProperties !== true) throw new Error(`Unknown configuration key: ${key}`);
    if (secrets.has(key) && value === '' && existing[key] !== undefined) {
      output[key] = existing[key];
      continue;
    }
    if (property) validateProperty(key, property, value);
    output[key] = value;
  }
  for (const key of schema?.required ?? []) {
    const value = output[key] ?? existing[key];
    if (value === undefined || value === null || value === '') throw new Error(`${key} is required`);
  }
  return output;
}

async function notifyChange(event: string, id?: string, name?: string) {
  broadcastToAdmins('plugin:changed', { event, id, name, at: new Date().toISOString() });
}

export const pluginsAdminPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/admin/plugins', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const result = await db().query<PluginDbRow>('select * from plugins order by lower(name), id');
    return {
      ok: true,
      executionEnabled: pluginsEnabledGlobally(),
      uploadLimitBytes: pluginUploadLimitBytes(),
      plugins: await Promise.all(result.rows.map(serializePlugin)),
    };
  });

  app.post('/api/admin/plugins/upload', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const part = await req.file({ limits: { files: 1, fileSize: pluginUploadLimitBytes() } });
      if (!part) return reply.code(400).send({ ok: false, error: 'Select an .ndp plugin package' });
      const buffer = await part.toBuffer();
      const installed = await installPluginPackage(buffer, part.filename);
      await audit('plugin_installed', {
        by: req.user!.userId,
        pluginId: installed.parsed.id,
        version: installed.parsed.manifest.version,
        sha256: installed.parsed.packageSha256,
        state: installed.state,
      });
      await notifyChange(installed.state, installed.parsed.id, installed.parsed.manifest.name);
      const row = await getPluginRow(installed.parsed.id);
      return reply.code(installed.state === 'installed' ? 201 : 200).send({ ok: true, plugin: await serializePlugin(row!) });
    } catch (error) {
      const message = errorMessage(error);
      broadcastToAdmins('plugin:error', { operation: 'upload', error: message });
      return reply.code(400).send({ ok: false, error: message });
    }
  });

  app.post('/api/admin/plugins/rescan', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const result = await rescanPlugins();
    await audit('plugins_rescanned', { by: req.user!.userId, ...result });
    if (result.installed.length || result.updated.length || result.errors.length) await notifyChange('rescan');
    return { ok: true, ...result };
  });

  app.put('/api/admin/plugins/:id/config', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = await getPluginRow(id);
    if (!row) return reply.code(404).send({ ok: false, error: 'Plugin not found' });
    try {
      const body = req.body as { config?: unknown } | undefined;
      const config = validateObjectInput(
        body?.config,
        row.manifest.config?.schema,
        row.config ?? {},
        secretConfigKeys(row.manifest)
      );
      if (id === MISSING_MUSIC_PLUGIN_ID) await validateMissingMusicConfig(config);
      await db().query('update plugins set config=$2, updated_at=now(), last_error=null where id=$1', [id, config]);
      await audit('plugin_config_updated', { by: req.user!.userId, pluginId: id, keys: Object.keys(config) });
      await notifyChange('configured', id, row.name);
      return { ok: true, plugin: await serializePlugin((await getPluginRow(id))!) };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.put('/api/admin/plugins/:id/enabled', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = await getPluginRow(id);
    if (!row) return reply.code(404).send({ ok: false, error: 'Plugin not found' });
    const body = req.body as { enabled?: unknown; permissionFingerprint?: unknown } | undefined;
    if (typeof body?.enabled !== 'boolean') return reply.code(400).send({ ok: false, error: 'enabled must be true or false' });
    try {
      if (body.enabled) {
        if (!pluginsEnabledGlobally()) throw new Error('Plugin execution is disabled by PLUGINS_ENABLED');
        if (body.permissionFingerprint !== row.permission_fingerprint) throw new Error('Plugin permissions changed; reload the page and review them again');
        await inspectPlugin(id);
      }
      await db().query('update plugins set enabled=$2, updated_at=now(), last_error=null where id=$1', [id, body.enabled]);
      await audit(body.enabled ? 'plugin_enabled' : 'plugin_disabled', { by: req.user!.userId, pluginId: id, permissionFingerprint: row.permission_fingerprint });
      await notifyChange(body.enabled ? 'enabled' : 'disabled', id, row.name);
      return { ok: true, plugin: await serializePlugin((await getPluginRow(id))!) };
    } catch (error) {
      const message = errorMessage(error);
      await db().query('update plugins set enabled=false,last_error=$2 where id=$1', [id, message]).catch(() => undefined);
      broadcastToAdmins('plugin:error', { operation: 'enable', id, error: message });
      return reply.code(400).send({ ok: false, error: message });
    }
  });

  app.post('/api/admin/plugins/:id/test', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    try {
      const result = await inspectPlugin(id);
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.get('/api/admin/plugins/:id/runs', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = await getPluginRow(id);
    if (!row) return reply.code(404).send({ ok: false, error: 'Plugin not found' });
    const result = await db().query(
      `select id,export_name,ok,duration_ms,error,logs,created_at
         from plugin_runs where plugin_id=$1 order by created_at desc limit 100`,
      [id]
    );
    return { ok: true, runs: result.rows };
  });

  app.post('/api/admin/plugins/:id/actions/:actionId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id, actionId } = req.params as { id: string; actionId: string };
    const row = await getPluginRow(id);
    if (!row) return reply.code(404).send({ ok: false, error: 'Plugin not found' });
    const action = (row.manifest.mvbar?.actions ?? []).find((candidate: PluginAction) => candidate.id === actionId);
    if (!action) return reply.code(404).send({ ok: false, error: 'Plugin action not found' });
    try {
      const body = req.body as { input?: unknown } | undefined;
      const input = validateObjectInput(body?.input ?? {}, action.inputSchema, {});
      const output = await callPluginExport(id, action.export, input);
      await audit('plugin_action_called', { by: req.user!.userId, pluginId: id, actionId });
      return { ok: true, output };
    } catch (error) {
      const message = errorMessage(error);
      broadcastToAdmins('plugin:error', { operation: 'action', id, actionId, error: message });
      return reply.code(400).send({ ok: false, error: message });
    }
  });

  app.delete('/api/admin/plugins/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = await getPluginRow(id);
    if (!row) return reply.code(404).send({ ok: false, error: 'Plugin not found' });
    try {
      await removePluginPackage(row);
      await db().query('delete from plugins where id=$1', [id]);
      const dataPath = pluginPackagePath(row.filename);
      await audit('plugin_removed', { by: req.user!.userId, pluginId: id, package: dataPath });
      await notifyChange('removed', id, row.name);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });
});

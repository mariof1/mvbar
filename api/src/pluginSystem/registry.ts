import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import logger from '../logger.js';
import { packageFilenameForId, parsePluginPackage, pluginUploadLimitBytes } from './package.js';
import type { ParsedPluginPackage, PluginDbRow } from './types.js';

const DEFAULT_PLUGIN_DIR = '/data/plugins';
const RESCAN_INTERVAL_MS = 30_000;

let scanInFlight: Promise<PluginScanResult> | null = null;
let watcherStarted = false;

export type PluginScanResult = {
  found: number;
  installed: string[];
  updated: string[];
  errors: Array<{ filename: string; error: string }>;
};

export function pluginsEnabledGlobally() {
  return !['0', 'false', 'no', 'off'].includes((process.env.PLUGINS_ENABLED ?? 'true').trim().toLowerCase());
}

export function pluginDirectory() {
  return path.resolve(process.env.PLUGINS_DIR ?? DEFAULT_PLUGIN_DIR);
}

export function pluginDataDirectory(id: string) {
  return path.join(pluginDirectory(), 'data', id);
}

export function pluginPackagePath(filename: string) {
  const safe = path.basename(filename);
  if (safe !== filename || !safe.toLowerCase().endsWith('.ndp')) throw new Error('Unsafe plugin package filename');
  const root = pluginDirectory();
  const resolved = path.resolve(root, safe);
  if (path.dirname(resolved) !== root) throw new Error('Unsafe plugin package path');
  return resolved;
}

export async function ensurePluginDirectories() {
  await fs.mkdir(pluginDirectory(), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(pluginDirectory(), 'data'), { recursive: true, mode: 0o700 });
}

async function upsertPackage(plugin: ParsedPluginPackage): Promise<'installed' | 'updated' | 'unchanged'> {
  const existing = await db().query<Pick<PluginDbRow, 'id' | 'package_sha256' | 'permission_fingerprint' | 'enabled' | 'config'>>(
    'select id, package_sha256, permission_fingerprint, enabled, config from plugins where id=$1',
    [plugin.id]
  );
  const previous = existing.rows[0];
  const changed = Boolean(previous && previous.package_sha256 !== plugin.packageSha256);
  const permissionChanged = Boolean(previous && previous.permission_fingerprint !== plugin.permissionFingerprint);
  const enabled = previous ? previous.enabled && !changed && !permissionChanged : false;

  await db().query(
    `insert into plugins (
       id, filename, name, author, version, description, homepage, manifest,
       enabled, package_sha256, permission_fingerprint, updated_at, last_error
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),null)
     on conflict (id) do update set
       filename=excluded.filename,
       name=excluded.name,
       author=excluded.author,
       version=excluded.version,
       description=excluded.description,
       homepage=excluded.homepage,
       manifest=excluded.manifest,
       enabled=excluded.enabled,
       package_sha256=excluded.package_sha256,
       permission_fingerprint=excluded.permission_fingerprint,
       updated_at=case when plugins.package_sha256 <> excluded.package_sha256 then now() else plugins.updated_at end,
       last_error=null`,
    [
      plugin.id,
      plugin.filename,
      plugin.manifest.name.trim(),
      plugin.manifest.author.trim(),
      plugin.manifest.version.trim(),
      plugin.manifest.description?.trim() || null,
      (plugin.manifest.homepage ?? plugin.manifest.website)?.trim() || null,
      plugin.manifest,
      enabled,
      plugin.packageSha256,
      plugin.permissionFingerprint,
    ]
  );
  if (!previous) return 'installed';
  return changed ? 'updated' : 'unchanged';
}

async function scanNow(): Promise<PluginScanResult> {
  await ensurePluginDirectories();
  const result: PluginScanResult = { found: 0, installed: [], updated: [], errors: [] };
  const files = (await fs.readdir(pluginDirectory(), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ndp'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  result.found = files.length;
  const presentFilenames: string[] = [];
  const seenIds = new Set<string>();

  for (const filename of files) {
    try {
      const packagePath = pluginPackagePath(filename);
      const stat = await fs.stat(packagePath);
      if (!stat.isFile() || stat.size > pluginUploadLimitBytes()) throw new Error('Plugin package exceeds the configured upload limit');
      const parsed = await parsePluginPackage(await fs.readFile(packagePath), filename);
      if (seenIds.has(parsed.id)) throw new Error(`Another package already uses plugin id ${parsed.id}`);
      seenIds.add(parsed.id);
      presentFilenames.push(filename);
      const state = await upsertPackage(parsed);
      if (state === 'installed') result.installed.push(parsed.id);
      if (state === 'updated') result.updated.push(parsed.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({ filename, error: message });
      logger.warn('plugins', `Rejected ${filename}: ${message}`);
    }
  }

  await db().query(
    `update plugins
        set enabled=false,
            last_error='Plugin package is missing from the plugin directory'
      where not (filename = any($1::text[]))`,
    [presentFilenames]
  );
  return result;
}

export function rescanPlugins(): Promise<PluginScanResult> {
  if (scanInFlight) return scanInFlight;
  scanInFlight = scanNow().finally(() => {
    scanInFlight = null;
  });
  return scanInFlight;
}

export async function installPluginPackage(buffer: Buffer, originalFilename: string) {
  await ensurePluginDirectories();
  const parsed = await parsePluginPackage(buffer, originalFilename);
  const targetFilename = packageFilenameForId(parsed.id);
  const targetPath = pluginPackagePath(targetFilename);
  const temporaryPath = pluginPackagePath(`upload-${crypto.randomUUID()}.ndp`);
  await fs.writeFile(temporaryPath, buffer, { flag: 'wx', mode: 0o600 });
  try {
    await fs.copyFile(temporaryPath, targetPath);
    await fs.chmod(targetPath, 0o600).catch(() => undefined);
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
  parsed.filename = targetFilename;
  const state = await upsertPackage(parsed);
  return { parsed, state };
}

export async function removePluginPackage(row: Pick<PluginDbRow, 'id' | 'filename'>) {
  await fs.unlink(pluginPackagePath(row.filename)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await fs.rm(pluginDataDirectory(row.id), { recursive: true, force: true });
}

export async function getPluginRow(id: string) {
  const result = await db().query<PluginDbRow>('select * from plugins where id=$1', [id]);
  return result.rows[0] ?? null;
}

export async function getPluginPackage(row: Pick<PluginDbRow, 'id' | 'filename' | 'package_sha256'>) {
  const buffer = await fs.readFile(pluginPackagePath(row.filename));
  const parsed = await parsePluginPackage(buffer, row.filename);
  if (parsed.id !== row.id) throw new Error(`Package id changed from ${row.id} to ${parsed.id}; rescan plugins`);
  if (parsed.packageSha256 !== row.package_sha256) throw new Error('Plugin package changed on disk; rescan plugins before enabling it');
  return parsed;
}

export async function initializePluginSystem() {
  const scan = await rescanPlugins();
  logger.info('plugins', `Plugin directory ready (${scan.found} package${scan.found === 1 ? '' : 's'})`);
  if (!pluginsEnabledGlobally()) logger.info('plugins', 'Plugin execution is disabled by PLUGINS_ENABLED');
  if (!watcherStarted) {
    watcherStarted = true;
    const timer = setInterval(() => {
      void rescanPlugins().catch((error) => logger.error('plugins', `Automatic rescan failed: ${error instanceof Error ? error.message : String(error)}`));
    }, RESCAN_INTERVAL_MS);
    timer.unref();
  }
}

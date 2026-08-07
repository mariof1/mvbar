import fp from 'fastify-plugin';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { ZipArchive } from 'archiver';
import * as unzipper from 'unzipper';
import { to as copyTo } from 'pg-copy-streams';
import type { PoolClient } from 'pg';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { db, redis } from './db.js';
import { broadcastToAdmins } from './websocket.js';

const BACKUP_FORMAT = 'mvbar-portable-backup';
const BACKUP_FORMAT_VERSION = 2;
const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_MAX_UPLOAD_MB = 20 * 1024;
const MAX_UPLOAD_BYTES = Math.max(
  1,
  Number.parseInt(process.env.BACKUP_MAX_UPLOAD_MB ?? String(DEFAULT_MAX_UPLOAD_MB), 10) || DEFAULT_MAX_UPLOAD_MB,
) * 1024 * 1024;
const MAX_EXTRACTED_BYTES = MAX_UPLOAD_BYTES * 3;
const INSERT_BATCH_SIZE = 500;
const BACKUP_DIRECTORY = process.env.BACKUP_DIR ?? '/data/backups';
const BACKUP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.mvbar-backup$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;

type TableInfo = {
  name: string;
  columns: string[];
  dependencies: string[];
};

type CacheManifest = {
  included: boolean;
  categories: Array<{ key: string; files: number; bytes: number }>;
};

type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  createdAt: string;
  app: {
    version: string;
    commit: string;
  };
  database: {
    format: 'postgres-jsonl-v2';
    tables: TableInfo[];
  };
  caches: CacheManifest;
};

export type StoredBackup = {
  name: string;
  size: number;
  createdAt: string;
  storedAt: string;
  includesCaches: boolean;
  cacheFiles: number;
  cacheBytes: number;
  appVersion: string;
  commit: string;
};

type BackupJob = {
  id: string;
  startedAt: string;
  includeCaches: boolean;
};

type CacheCategory = {
  key: string;
  root: string;
};

type RestoreContext = {
  restoreCaches: boolean;
  libraryMapping: Map<string, string>;
  podcastRoot: string;
};

let restoreInProgress = false;
let backupInProgress: BackupJob | null = null;

export function isSafeBackupName(name: string) {
  return BACKUP_NAME_RE.test(name) && path.basename(name) === name;
}

function qident(value: string) {
  if (!IDENTIFIER_RE.test(value)) throw new Error(`Unsafe database identifier: ${value}`);
  return `"${value}"`;
}

function parseDirectories(value: string | undefined, fallback: string[] = []) {
  const parsed = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function cacheCategories(): CacheCategory[] {
  return [
    { key: 'art', root: process.env.ART_DIR ?? '/data/cache/art' },
    { key: 'lyrics', root: process.env.LYRICS_DIR ?? '/data/cache/lyrics' },
    { key: 'avatars', root: process.env.AVATARS_DIR ?? '/data/cache/avatars' },
    { key: 'hls', root: process.env.HLS_DIR ?? '/hls' },
    { key: 'podcasts', root: process.env.PODCAST_DIR ?? '/podcasts' },
    { key: 'podcast-art', root: process.env.PODCAST_ART_DIR ?? '/data/cache/podcast-art' },
    { key: 'audiobook-art', root: process.env.AUDIOBOOK_ART_DIR ?? '/data/cache/audiobook-art' },
  ];
}

async function getTableInfo(client: PoolClient): Promise<TableInfo[]> {
  const tableResult = await client.query<{ name: string; columns: string[] }>(`
    SELECT
      table_class.relname AS name,
      array_agg(attribute.attname ORDER BY attribute.attnum)::text[] AS columns
    FROM pg_class AS table_class
    JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
    JOIN pg_attribute AS attribute ON attribute.attrelid = table_class.oid
    WHERE namespace.nspname = 'public'
      AND table_class.relkind IN ('r', 'p')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attgenerated = ''
    GROUP BY table_class.relname
    ORDER BY table_class.relname
  `);
  const dependencyResult = await client.query<{ name: string; dependency: string }>(`
    SELECT child.relname AS name, parent.relname AS dependency
    FROM pg_constraint AS foreign_key
    JOIN pg_class AS child ON child.oid = foreign_key.conrelid
    JOIN pg_namespace AS child_namespace ON child_namespace.oid = child.relnamespace
    JOIN pg_class AS parent ON parent.oid = foreign_key.confrelid
    JOIN pg_namespace AS parent_namespace ON parent_namespace.oid = parent.relnamespace
    WHERE foreign_key.contype = 'f'
      AND child_namespace.nspname = 'public'
      AND parent_namespace.nspname = 'public'
  `);
  const dependencies = new Map<string, Set<string>>();
  for (const row of dependencyResult.rows) {
    if (row.name === row.dependency) continue;
    const values = dependencies.get(row.name) ?? new Set<string>();
    values.add(row.dependency);
    dependencies.set(row.name, values);
  }
  return tableResult.rows.map((row) => ({
    name: row.name,
    columns: row.columns,
    dependencies: [...(dependencies.get(row.name) ?? [])].sort(),
  }));
}

export function sortTablesByDependencies(tables: TableInfo[]) {
  const names = new Set(tables.map((table) => table.name));
  const remaining = new Map(
    tables.map((table) => [
      table.name,
      new Set(table.dependencies.filter((dependency) => names.has(dependency))),
    ]),
  );
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => [...dependencies].every((dependency) => !remaining.has(dependency)))
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      // MVBar has no cross-table FK cycles. Keep deterministic behavior if a future
      // schema adds one; PostgreSQL will provide the actionable constraint error.
      ready.push([...remaining.keys()].sort()[0]);
    }
    for (const name of ready) {
      ordered.push(name);
      remaining.delete(name);
    }
  }
  return ordered;
}

async function listRegularFiles(root: string) {
  const files: Array<{ absolutePath: string; relativePath: string; size: number }> = [];
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch {
    return files;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return files;

  async function walk(directory: string, relativeDirectory: string) {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await walk(absolutePath, relativePath);
      if (stat.isFile()) files.push({ absolutePath, relativePath, size: stat.size });
    }
  }

  await walk(root, '');
  return files;
}

function portablePath(...parts: string[]) {
  return parts.map((part) => part.replaceAll('\\', '/')).join('/');
}

export function isSafeArchivePath(entryPath: string) {
  if (!entryPath || entryPath.includes('\\') || entryPath.includes('\0')) return false;
  if (entryPath.startsWith('/') || /^[A-Za-z]:/.test(entryPath)) return false;
  const normalized = path.posix.normalize(entryPath);
  return normalized === entryPath && normalized !== '..' && !normalized.startsWith('../');
}

async function createBackupArchive(includeCaches: boolean, output: PassThrough): Promise<BackupManifest> {
  const client = await db().connect();
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.pipe(output);
  archive.on('warning', (error: Error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') output.destroy(error);
  });
  archive.on('error', (error: Error) => output.destroy(error));

  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await getTableInfo(client);
    for (const table of sortTablesByDependencies(tables)) {
      // CSV mode avoids COPY text's backslash escaping. JSON never contains
      // these control-byte delimiters literally, so every output row is JSONL.
      const stream = client.query(
        copyTo(`
          COPY (
            SELECT row_to_json(source_row)::text
            FROM public.${qident(table)} AS source_row
          ) TO STDOUT WITH (
            FORMAT csv,
            DELIMITER E'\\x01',
            QUOTE E'\\x02',
            ESCAPE E'\\x02'
          )
        `),
      );
      archive.append(stream, { name: `database/${table}.jsonl` });
      await finished(stream);
    }
    await client.query('COMMIT');

    const cacheManifest: CacheManifest = { included: includeCaches, categories: [] };
    if (includeCaches) {
      for (const category of cacheCategories()) {
        const files = await listRegularFiles(category.root);
        let bytes = 0;
        for (const file of files) {
          bytes += file.size;
          archive.file(file.absolutePath, {
            name: portablePath('cache', category.key, file.relativePath),
          });
        }
        cacheManifest.categories.push({ key: category.key, files: files.length, bytes });
      }
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      app: {
        version: process.env.APP_VERSION ?? '0.0.0-dev',
        commit: process.env.GIT_COMMIT ?? 'unknown',
      },
      database: { format: 'postgres-jsonl-v2', tables },
      caches: cacheManifest,
    };
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    await archive.finalize();
    return manifest;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    output.destroy(error as Error);
    throw error;
  } finally {
    client.release();
  }
}

async function extractArchive(archivePath: string, targetRoot: string) {
  const archive = await unzipper.Open.file(archivePath);
  const seen = new Set<string>();
  let extractedBytes = 0;
  for (const entry of archive.files) {
    const entryPath = entry.path.replace(/\/$/, '');
    if (entry.type === 'Directory') continue;
    if (entry.type !== 'File' || !isSafeArchivePath(entryPath) || seen.has(entryPath)) {
      throw new Error(`Invalid archive entry: ${entry.path}`);
    }
    if (!isAllowedArchivePath(entryPath)) throw new Error(`Unsupported archive entry: ${entryPath}`);
    seen.add(entryPath);
    extractedBytes += entry.uncompressedSize;
    if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('Backup expands beyond the configured safety limit');

    const destination = path.join(targetRoot, ...entryPath.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    let actualBytes = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        actualBytes += chunk.length;
        if (actualBytes > MAX_EXTRACTED_BYTES || extractedBytes - entry.uncompressedSize + actualBytes > MAX_EXTRACTED_BYTES) {
          callback(new Error('Backup expands beyond the configured safety limit'));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(entry.stream(), counter, createWriteStream(destination, { flags: 'wx' }));
  }
  return seen;
}

function validateManifest(value: unknown): asserts value is BackupManifest {
  if (!value || typeof value !== 'object') throw new Error('Backup manifest is missing');
  const manifest = value as Partial<BackupManifest>;
  if (manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error('Unsupported MVBar backup format');
  }
  if (
    typeof manifest.createdAt !== 'string'
    || !Number.isFinite(Date.parse(manifest.createdAt))
    || typeof manifest.app?.version !== 'string'
    || typeof manifest.app?.commit !== 'string'
  ) {
    throw new Error('Backup application manifest is invalid');
  }
  if (manifest.database?.format !== 'postgres-jsonl-v2' || !Array.isArray(manifest.database.tables)) {
    throw new Error('Backup database manifest is invalid');
  }
  for (const table of manifest.database.tables) {
    if (
      !IDENTIFIER_RE.test(table.name)
      || !Array.isArray(table.columns)
      || table.columns.some((column) => !IDENTIFIER_RE.test(column))
      || new Set(table.columns).size !== table.columns.length
    ) {
      throw new Error('Backup contains an invalid database schema');
    }
  }
  if (!manifest.caches || !Array.isArray(manifest.caches.categories)) {
    throw new Error('Backup cache manifest is invalid');
  }
}

function isAllowedArchivePath(entryPath: string) {
  return entryPath === 'manifest.json'
    || /^database\/[a-z_][a-z0-9_]*\.jsonl$/.test(entryPath)
    || /^cache\/[a-z0-9-]+\/.+/.test(entryPath);
}

function backupMetadataPath(name: string) {
  return path.join(BACKUP_DIRECTORY, `${name}.metadata.json`);
}

function recordFromManifest(
  name: string,
  size: number,
  storedAt: string,
  manifest: BackupManifest,
): StoredBackup {
  return {
    name,
    size,
    createdAt: manifest.createdAt,
    storedAt,
    includesCaches: manifest.caches.included,
    cacheFiles: manifest.caches.categories.reduce((total, category) => total + category.files, 0),
    cacheBytes: manifest.caches.categories.reduce((total, category) => total + category.bytes, 0),
    appVersion: manifest.app.version,
    commit: manifest.app.commit,
  };
}

function isStoredBackup(value: unknown, expectedName: string): value is StoredBackup {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<StoredBackup>;
  return record.name === expectedName
    && typeof record.size === 'number'
    && typeof record.createdAt === 'string'
    && typeof record.storedAt === 'string'
    && typeof record.includesCaches === 'boolean'
    && typeof record.cacheFiles === 'number'
    && typeof record.cacheBytes === 'number'
    && typeof record.appVersion === 'string'
    && typeof record.commit === 'string';
}

async function inspectBackupArchive(archivePath: string) {
  const archive = await unzipper.Open.file(archivePath);
  const entries = new Set<string>();
  let manifestEntry: (typeof archive.files)[number] | undefined;
  for (const entry of archive.files) {
    const entryPath = entry.path.replace(/\/$/, '');
    if (entry.type === 'Directory') continue;
    if (
      entry.type !== 'File'
      || !isSafeArchivePath(entryPath)
      || !isAllowedArchivePath(entryPath)
      || entries.has(entryPath)
    ) {
      throw new Error(`Invalid archive entry: ${entry.path}`);
    }
    entries.add(entryPath);
    if (entryPath === 'manifest.json') manifestEntry = entry;
  }
  if (!manifestEntry || manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES) {
    throw new Error('Backup manifest is missing or too large');
  }
  const manifest = JSON.parse((await manifestEntry.buffer()).toString('utf8')) as unknown;
  validateManifest(manifest);
  for (const table of manifest.database.tables) {
    if (!entries.has(`database/${table.name}.jsonl`)) {
      throw new Error(`Backup table is missing: ${table.name}`);
    }
  }
  return manifest;
}

async function writeBackupMetadata(name: string, manifest: BackupManifest, storedAt = new Date().toISOString()) {
  const archivePath = path.join(BACKUP_DIRECTORY, name);
  const archiveStat = await lstat(archivePath);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) throw new Error('Stored backup is not a regular file');
  const record = recordFromManifest(name, archiveStat.size, storedAt, manifest);
  const metadataPath = backupMetadataPath(name);
  const temporaryPath = `${metadataPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rm(metadataPath, { force: true });
    await rename(temporaryPath, metadataPath);
    return record;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function getStoredBackup(name: string): Promise<StoredBackup> {
  if (!isSafeBackupName(name)) throw new Error('Invalid backup name');
  const archivePath = path.join(BACKUP_DIRECTORY, name);
  const archiveStat = await lstat(archivePath);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) throw new Error('Backup not found');
  try {
    const stored = JSON.parse(await readFile(backupMetadataPath(name), 'utf8')) as unknown;
    if (isStoredBackup(stored, name)) {
      return { ...stored, size: archiveStat.size };
    }
  } catch {
    // Rebuild missing or invalid metadata from the portable archive.
  }
  const manifest = await inspectBackupArchive(archivePath);
  return writeBackupMetadata(name, manifest, archiveStat.mtime.toISOString());
}

async function listStoredBackups() {
  await mkdir(BACKUP_DIRECTORY, { recursive: true });
  const entries = await readdir(BACKUP_DIRECTORY, { withFileTypes: true });
  const backups = await Promise.all(entries
    .filter((entry) => entry.isFile() && isSafeBackupName(entry.name))
    .map(async (entry) => {
      try {
        return await getStoredBackup(entry.name);
      } catch {
        return null;
      }
    }));
  return backups
    .filter((backup): backup is StoredBackup => backup !== null)
    .sort((left, right) => Date.parse(right.storedAt) - Date.parse(left.storedAt));
}

function newBackupName() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `mvbar-backup-${timestamp}-${randomUUID().slice(0, 8)}.mvbar-backup`;
}

async function createStoredBackup(includeCaches: boolean) {
  await mkdir(BACKUP_DIRECTORY, { recursive: true });
  const name = newBackupName();
  const archivePath = path.join(BACKUP_DIRECTORY, name);
  const temporaryPath = path.join(BACKUP_DIRECTORY, `.${randomUUID()}.tmp`);
  const output = new PassThrough();
  const writer = pipeline(output, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
  let archiveStored = false;
  try {
    const manifest = await createBackupArchive(includeCaches, output);
    await writer;
    await rename(temporaryPath, archivePath);
    archiveStored = true;
    return await writeBackupMetadata(name, manifest);
  } catch (error) {
    output.destroy();
    await writer.catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (archiveStored) {
      await rm(archivePath, { force: true }).catch(() => undefined);
      await rm(backupMetadataPath(name), { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function archiveHasAdmin(usersPath: string) {
  const lines = createInterface({ input: createReadStream(usersPath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { role?: unknown };
    if (row.role === 'admin') return true;
  }
  return false;
}

async function readLibraryMapping(librariesPath: string) {
  const rows: Array<{ id: string; mount_path: string; media_type: 'music' | 'audiobook'; enabled?: boolean }> = [];
  const lines = createInterface({ input: createReadStream(librariesPath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    if (typeof row.mount_path !== 'string' || (row.media_type !== 'music' && row.media_type !== 'audiobook')) continue;
    rows.push({
      id: String(row.id ?? ''),
      mount_path: row.mount_path,
      media_type: row.media_type,
      enabled: row.enabled !== false,
    });
  }
  const configured: Record<'music' | 'audiobook', string[]> = {
    music: parseDirectories(process.env.MUSIC_DIRS ?? process.env.MUSIC_DIR, ['/music']),
    audiobook: parseDirectories(process.env.AUDIOBOOK_DIRS),
  };
  const mapping = new Map<string, string>();
  for (const mediaType of ['music', 'audiobook'] as const) {
    const source = rows
      .filter((row) => row.media_type === mediaType)
      .sort((left, right) => Number(right.enabled) - Number(left.enabled) || left.id.localeCompare(right.id));
    source.forEach((row, index) => {
      const destination = configured[mediaType][index];
      if (destination) mapping.set(row.mount_path, destination);
    });
  }
  return mapping;
}

function transformRestoreRow(table: string, row: Record<string, unknown>, context: RestoreContext) {
  if (table === 'libraries' && typeof row.mount_path === 'string') {
    const mapped = context.libraryMapping.get(row.mount_path);
    if (mapped) {
      row.mount_path = mapped;
      row.enabled = true;
    } else {
      row.mount_path = `mvbar-unmapped://${String(row.id ?? 'unknown')}`;
      row.enabled = false;
    }
  }
  if (table === 'podcast_episodes' && typeof row.downloaded_path === 'string') {
    if (context.restoreCaches) {
      const filename = path.basename(row.downloaded_path);
      row.downloaded_path = path.join(context.podcastRoot, String(row.podcast_id), filename);
    } else {
      row.downloaded_path = null;
      row.downloaded_at = null;
    }
  }
  return row;
}

async function importTable(
  client: PoolClient,
  filePath: string,
  table: string,
  columns: string[],
  context: RestoreContext,
) {
  if (columns.length === 0) return 0;
  const quotedColumns = columns.map(qident).join(', ');
  const sql = `
    INSERT INTO public.${qident(table)} (${quotedColumns})
    SELECT ${quotedColumns}
    FROM json_populate_recordset(NULL::public.${qident(table)}, $1::json)
  `;
  let batch: Record<string, unknown>[] = [];
  let imported = 0;
  async function flush() {
    if (batch.length === 0) return;
    await client.query(sql, [JSON.stringify(batch)]);
    imported += batch.length;
    batch = [];
  }
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    batch.push(transformRestoreRow(table, row, context));
    if (batch.length >= INSERT_BATCH_SIZE) await flush();
  }
  await flush();
  return imported;
}

async function resetSequences(client: PoolClient, tables: TableInfo[]) {
  const serials = await client.query<{ table_name: string; column_name: string; sequence_name: string }>(`
    SELECT
      columns.table_name,
      columns.column_name,
      pg_get_serial_sequence(format('%I.%I', columns.table_schema, columns.table_name), columns.column_name) AS sequence_name
    FROM information_schema.columns AS columns
    WHERE columns.table_schema = 'public'
      AND columns.table_name = ANY($1::text[])
      AND pg_get_serial_sequence(format('%I.%I', columns.table_schema, columns.table_name), columns.column_name) IS NOT NULL
  `, [tables.map((table) => table.name)]);
  for (const serial of serials.rows) {
    const result = await client.query<{ maximum: string | null }>(
      `SELECT max(${qident(serial.column_name)})::text AS maximum FROM public.${qident(serial.table_name)}`,
    );
    const maximum = result.rows[0]?.maximum;
    await client.query('SELECT setval($1::regclass, $2::bigint, $3::boolean)', [
      serial.sequence_name,
      maximum ?? '1',
      maximum !== null,
    ]);
  }
}

async function ensureSafeDirectory(root: string, relativeDirectory: string) {
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe cache destination: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
  return current;
}

async function restoreCacheFiles(stagingRoot: string, manifest: BackupManifest) {
  const configured = new Map(cacheCategories().map((category) => [category.key, category.root]));
  let copied = 0;
  for (const category of manifest.caches.categories) {
    const destinationRoot = configured.get(category.key);
    if (!destinationRoot) continue;
    const sourceRoot = path.join(stagingRoot, 'cache', category.key);
    const files = await listRegularFiles(sourceRoot);
    for (const file of files) {
      const destinationDirectory = await ensureSafeDirectory(destinationRoot, path.dirname(file.relativePath));
      const destination = path.join(destinationDirectory, path.basename(file.relativePath));
      try {
        const existing = await lstat(destination);
        if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`Unsafe cache destination: ${destination}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await copyFile(file.absolutePath, destination);
      copied += 1;
    }
  }
  return copied;
}

async function restoreDatabase(stagingRoot: string, manifest: BackupManifest, restoreCaches: boolean) {
  const client = await db().connect();
  try {
    const targetTables = await getTableInfo(client);
    const targetByName = new Map(targetTables.map((table) => [table.name, table]));
    const sourceByName = new Map(manifest.database.tables.map((table) => [table.name, table]));
    const importable = targetTables.filter((table) => sourceByName.has(table.name));
    if (!sourceByName.has('users') || !targetByName.has('users')) throw new Error('Backup does not contain the users table');
    const usersPath = path.join(stagingRoot, 'database', 'users.jsonl');
    if (!await archiveHasAdmin(usersPath)) throw new Error('Backup must contain at least one administrator');
    const librariesPath = path.join(stagingRoot, 'database', 'libraries.jsonl');
    const libraryMapping = sourceByName.has('libraries')
      ? await readLibraryMapping(librariesPath)
      : new Map<string, string>();
    const context: RestoreContext = {
      restoreCaches,
      libraryMapping,
      podcastRoot: process.env.PODCAST_DIR ?? '/podcasts',
    };

    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('mvbar-portable-restore'))");
    await client.query(`TRUNCATE ${targetTables.map((table) => `public.${qident(table.name)}`).join(', ')} RESTART IDENTITY CASCADE`);

    let rows = 0;
    const ordered = sortTablesByDependencies(importable);
    for (const tableName of ordered) {
      const target = targetByName.get(tableName)!;
      const source = sourceByName.get(tableName)!;
      const columns = source.columns.filter((column) => target.columns.includes(column));
      rows += await importTable(
        client,
        path.join(stagingRoot, 'database', `${tableName}.jsonl`),
        tableName,
        columns,
        context,
      );
    }
    await resetSequences(client, importable);
    await client.query('UPDATE users SET session_version = session_version + 1');
    if (targetByName.has('audit_events')) {
      await client.query(
        `INSERT INTO audit_events(event, meta) VALUES ('portable_backup_restored', $1::jsonb)`,
        [JSON.stringify({ sourceCreatedAt: manifest.createdAt, sourceVersion: manifest.app.version })],
      );
    }
    await client.query('COMMIT');
    return { rows, tables: ordered.length, librariesRemapped: libraryMapping.size };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function restoreArchiveFile(archivePath: string, requestedCaches: boolean, log: FastifyBaseLogger) {
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'mvbar-restore-'));
  try {
    const extractedRoot = path.join(stagingRoot, 'extracted');
    await mkdir(extractedRoot);
    const entries = await extractArchive(archivePath, extractedRoot);
    if (!entries.has('manifest.json')) throw new Error('Backup manifest is missing');
    const manifest = JSON.parse(await readFile(path.join(extractedRoot, 'manifest.json'), 'utf8')) as unknown;
    validateManifest(manifest);
    for (const table of manifest.database.tables) {
      if (!entries.has(`database/${table.name}.jsonl`)) throw new Error(`Backup table is missing: ${table.name}`);
    }
    const restoreCaches = requestedCaches && manifest.caches.included;
    const databaseResult = await restoreDatabase(extractedRoot, manifest, restoreCaches);
    let cacheFiles = 0;
    let cacheWarning: string | undefined;
    if (restoreCaches) {
      try {
        cacheFiles = await restoreCacheFiles(extractedRoot, manifest);
      } catch (error) {
        cacheWarning = error instanceof Error ? error.message : 'Cache restore failed';
        log.error({ err: error }, 'Database restored but optional cache restore failed');
      }
    }
    let reindexQueued = false;
    let reindexWarning: string | undefined;
    try {
      const listeners = await redis().publish(
        'library:commands',
        JSON.stringify({ command: 'rescan', by: 'portable-restore', force: true }),
      );
      reindexQueued = listeners > 0;
      if (!reindexQueued) reindexWarning = 'Library worker is unavailable; run a full library scan to rebuild search';
      await redis().publish(
        'audiobook:commands',
        JSON.stringify({ command: 'rescan', by: 'portable-restore' }),
      );
    } catch (error) {
      reindexWarning = 'Could not queue a full library scan; run one from Admin → Library';
      log.error({ err: error }, 'Database restored but search reconciliation could not be queued');
    }
    const warnings = [cacheWarning, reindexWarning].filter(Boolean);
    return {
      ok: true as const,
      ...databaseResult,
      cachesRestored: restoreCaches,
      cacheFiles,
      reindexQueued,
      warning: warnings.length > 0 ? warnings.join(' ') : undefined,
      sessionsInvalidated: true as const,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const backupPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/admin/backups', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    return { ok: true, backups: await listStoredBackups(), creating: backupInProgress };
  });

  app.post('/api/admin/backups', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    if (restoreInProgress) return reply.code(409).send({ ok: false, error: 'A restore is currently running' });
    if (backupInProgress) return reply.code(409).send({ ok: false, error: 'A backup is already running' });
    const includeCaches = Boolean((req.body as { includeCaches?: boolean } | undefined)?.includeCaches);
    const job: BackupJob = { id: randomUUID(), startedAt: new Date().toISOString(), includeCaches };
    backupInProgress = job;
    broadcastToAdmins('backup:started', { job });
    void createStoredBackup(includeCaches)
      .then((backup) => {
        backupInProgress = null;
        broadcastToAdmins('backup:created', { backup, source: 'created' });
        app.log.info({ backup: backup.name, bytes: backup.size }, 'Server backup created');
      })
      .catch((error) => {
        backupInProgress = null;
        app.log.error({ err: error }, 'Server backup creation failed');
        broadcastToAdmins('backup:error', {
          operation: 'create',
          error: error instanceof Error ? error.message : 'Backup creation failed',
        });
      });
    return reply.code(202).send({ ok: true, job });
  });

  app.post('/api/admin/backups/upload', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    if (restoreInProgress) return reply.code(409).send({ ok: false, error: 'A restore is currently running' });
    await mkdir(BACKUP_DIRECTORY, { recursive: true });
    const temporaryPath = path.join(BACKUP_DIRECTORY, `.${randomUUID()}.upload`);
    let archivePath: string | null = null;
    try {
      const upload = await req.file({ limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } });
      if (!upload) return reply.code(400).send({ ok: false, error: 'Backup file is required' });
      await pipeline(upload.file, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
      if (upload.file.truncated) return reply.code(413).send({ ok: false, error: 'Backup exceeds the configured upload limit' });
      const manifest = await inspectBackupArchive(temporaryPath);
      const name = newBackupName();
      archivePath = path.join(BACKUP_DIRECTORY, name);
      await rename(temporaryPath, archivePath);
      const backup = await writeBackupMetadata(name, manifest);
      broadcastToAdmins('backup:created', { backup, source: 'uploaded' });
      return reply.code(201).send({ ok: true, backup });
    } catch (error) {
      if (archivePath) await rm(archivePath, { force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : 'Backup upload failed';
      return reply.code(400).send({ ok: false, error: message });
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  });

  app.get('/api/admin/backups/:name/download', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const { name } = req.params as { name: string };
    try {
      const backup = await getStoredBackup(name);
      return reply
        .type('application/zip')
        .header('Content-Disposition', `attachment; filename="${backup.name}"`)
        .header('Content-Length', backup.size)
        .header('Cache-Control', 'no-store')
        .send(createReadStream(path.join(BACKUP_DIRECTORY, backup.name)));
    } catch {
      return reply.code(404).send({ ok: false, error: 'Backup not found' });
    }
  });

  app.delete('/api/admin/backups/:name', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    if (restoreInProgress) return reply.code(409).send({ ok: false, error: 'A restore is currently running' });
    const { name } = req.params as { name: string };
    try {
      const backup = await getStoredBackup(name);
      await rm(path.join(BACKUP_DIRECTORY, backup.name));
      await rm(backupMetadataPath(backup.name), { force: true });
      broadcastToAdmins('backup:deleted', { name: backup.name });
      return { ok: true };
    } catch {
      return reply.code(404).send({ ok: false, error: 'Backup not found' });
    }
  });

  app.post('/api/admin/backups/:name/restore', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    if (backupInProgress) return reply.code(409).send({ ok: false, error: 'A backup is currently running' });
    if (restoreInProgress) return reply.code(409).send({ ok: false, error: 'A restore is already running' });
    const { name } = req.params as { name: string };
    const requestedCaches = (req.query as { restoreCaches?: string }).restoreCaches === 'true';
    restoreInProgress = true;
    try {
      const backup = await getStoredBackup(name);
      return await restoreArchiveFile(path.join(BACKUP_DIRECTORY, backup.name), requestedCaches, req.log);
    } catch (error) {
      req.log.error({ err: error }, 'Stored backup restore failed');
      const message = error instanceof Error ? error.message : 'Restore failed';
      return reply.code(400).send({ ok: false, error: message });
    } finally {
      restoreInProgress = false;
    }
  });

  // Legacy direct-download endpoint now also persists the generated archive.
  app.get('/api/admin/backup', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    if (restoreInProgress) return reply.code(409).send({ ok: false, error: 'A restore is currently running' });
    if (backupInProgress) return reply.code(409).send({ ok: false, error: 'A backup is already running' });
    const includeCaches = (req.query as { includeCaches?: string }).includeCaches === 'true';
    const job: BackupJob = { id: randomUUID(), startedAt: new Date().toISOString(), includeCaches };
    backupInProgress = job;
    broadcastToAdmins('backup:started', { job });
    try {
      const backup = await createStoredBackup(includeCaches);
      backupInProgress = null;
      broadcastToAdmins('backup:created', { backup, source: 'created' });
      return reply
        .type('application/zip')
        .header('Content-Disposition', `attachment; filename="${backup.name}"`)
        .header('Content-Length', backup.size)
        .header('Cache-Control', 'no-store')
        .send(createReadStream(path.join(BACKUP_DIRECTORY, backup.name)));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Backup creation failed';
      broadcastToAdmins('backup:error', { operation: 'create', error: message });
      return reply.code(500).send({ ok: false, error: message });
    } finally {
      backupInProgress = null;
    }
  });

  // Keep uploaded restore support for transferring an archive from another installation.
  app.post('/api/admin/restore', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    if (backupInProgress) return reply.code(409).send({ ok: false, error: 'A backup is currently running' });
    if (restoreInProgress) return reply.code(409).send({ ok: false, error: 'A restore is already running' });
    restoreInProgress = true;
    const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'mvbar-upload-'));
    try {
      const upload = await req.file({ limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } });
      if (!upload) return reply.code(400).send({ ok: false, error: 'Backup file is required' });
      const archivePath = path.join(stagingRoot, 'upload.mvbar-backup');
      await pipeline(upload.file, createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
      if (upload.file.truncated) return reply.code(413).send({ ok: false, error: 'Backup exceeds the configured upload limit' });
      return await restoreArchiveFile(
        archivePath,
        (req.query as { restoreCaches?: string }).restoreCaches === 'true',
        req.log,
      );
    } catch (error) {
      req.log.error({ err: error }, 'Portable backup restore failed');
      const message = error instanceof Error ? error.message : 'Restore failed';
      return reply.code(400).send({ ok: false, error: message });
    } finally {
      restoreInProgress = false;
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

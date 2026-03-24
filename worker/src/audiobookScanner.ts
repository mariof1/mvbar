import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import logger from './logger.js';
import { readTags } from './metadata.js';
import { writeArt } from './art.js';

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.m4b', '.flac', '.aac', '.ogg', '.opus', '.wav']);
const COVER_NAMES = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png'];
const ART_DIR = '/data/cache/audiobook-art';

// ── Helpers ─────────────────────────────────────────────────

function naturalSort(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const aParts = a.match(re) || [];
  const bParts = b.match(re) || [];
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] || '';
    const bPart = bParts[i] || '';
    const aNum = Number(aPart);
    const bNum = Number(bPart);
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum;
    } else {
      const cmp = aPart.localeCompare(bPart);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    default: return 'image/jpeg';
  }
}

/** Normalize a string into a stable grouping key component. */
function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Build a stable grouping key from author + title. */
function groupKey(author: string, title: string): string {
  return `${normalize(author)}::${normalize(title)}`;
}

// ── Types ───────────────────────────────────────────────────

interface ScannedFile {
  absolutePath: string;
  parentDir: string;
  filename: string;
  // Metadata (null if tag reading failed)
  album: string | null;
  albumArtist: string | null;
  artist: string | null;
  title: string | null;
  language: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  durationMs: number | null;
  artData: Uint8Array | null;
  artMime: string | null;
  sizeBytes: number;
  mtimeMs: number;
}

interface AudiobookGroup {
  key: string;           // stable grouping key
  title: string;         // audiobook title
  author: string | null;
  narrator: string | null;
  language: string | null;
  files: ScannedFile[];  // chapters in this audiobook
}

// ── Step 1: Recursively collect all audio files ─────────────

async function collectAllAudioFiles(rootDirs: string[]): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  const stack = [...rootDirs];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!AUDIO_EXTS.has(ext)) continue;

        let st;
        try {
          st = await stat(fullPath);
        } catch {
          continue;
        }

        // Read tags
        let tags: Awaited<ReturnType<typeof readTags>> | null = null;
        try {
          tags = await readTags(fullPath);
        } catch {
          // Tags unavailable — will use filename/directory fallback
        }

        files.push({
          absolutePath: fullPath,
          parentDir: dir,
          filename: entry.name,
          album: tags?.album ?? null,
          albumArtist: tags?.albumartist ?? null,
          artist: tags?.artist ?? null,
          title: tags?.title ?? null,
          language: tags?.language ?? null,
          trackNumber: tags?.trackNumber ?? null,
          discNumber: tags?.discNumber ?? null,
          durationMs: tags?.durationMs ?? null,
          artData: tags?.artData ?? null,
          artMime: tags?.artMime ?? null,
          sizeBytes: st.size,
          mtimeMs: Math.floor(st.mtimeMs),
        });
      }
    }
  }

  return files;
}

// ── Step 2: Smart grouping ──────────────────────────────────

function groupFilesIntoAudiobooks(files: ScannedFile[]): AudiobookGroup[] {
  const groups = new Map<string, ScannedFile[]>();

  for (const file of files) {
    let key: string;

    if (file.album) {
      // Primary: group by album tag + author for disambiguation
      const author = file.albumArtist || file.artist || 'Unknown';
      key = groupKey(author, file.album);
    } else {
      // Fallback: group by parent directory (compatible with folder-based layouts)
      key = `dir::${file.parentDir}`;
    }

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(file);
  }

  const result: AudiobookGroup[] = [];

  for (const [key, groupFiles] of groups) {
    // Determine audiobook metadata from the group using majority vote
    const title = mostCommon(groupFiles.map(f => f.album).filter(Boolean) as string[])
      || path.basename(groupFiles[0].parentDir);

    const authorCandidates = groupFiles
      .map(f => f.albumArtist || f.artist)
      .filter(Boolean) as string[];
    const author = mostCommon(authorCandidates) || null;

    // Narrator: if artist differs from albumArtist consistently, it's likely the narrator
    const narratorCandidates = groupFiles
      .filter(f => f.albumArtist && f.artist && f.albumArtist !== f.artist)
      .map(f => f.artist!)
      .filter(Boolean);
    const narrator = mostCommon(narratorCandidates) || null;

    const langCandidates = groupFiles.map(f => f.language).filter(Boolean) as string[];
    const language = mostCommon(langCandidates) || null;

    // Use a stable key based on resolved author+title
    const stableKey = key.startsWith('dir::')
      ? groupKey(author || 'Unknown', title)
      : key;

    // Sort chapters: disc number → track number → filename
    groupFiles.sort((a, b) => {
      const discA = a.discNumber ?? 0;
      const discB = b.discNumber ?? 0;
      if (discA !== discB) return discA - discB;

      const trackA = a.trackNumber ?? Infinity;
      const trackB = b.trackNumber ?? Infinity;
      if (trackA !== trackB) return trackA - trackB;

      return naturalSort(a.filename, b.filename);
    });

    result.push({ key: stableKey, title, author, narrator, language, files: groupFiles });
  }

  return result;
}

/** Pick the most common string from a list. */
function mostCommon(arr: string[]): string | null {
  if (arr.length === 0) return null;
  const counts = new Map<string, number>();
  for (const s of arr) {
    const key = normalize(s);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  // Return the original (un-normalized) version of the most common
  const origMap = new Map<string, string>();
  for (const s of arr) {
    const key = normalize(s);
    if (!origMap.has(key)) origMap.set(key, s);
  }
  for (const [key, count] of counts) {
    if (count > bestCount) { best = key; bestCount = count; }
  }
  return origMap.get(best) || arr[0];
}

// ── Step 3: Cover art detection ─────────────────────────────

async function detectGroupCover(group: AudiobookGroup): Promise<string | null> {
  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);

  // Collect all unique directories containing this audiobook's files
  const dirs = [...new Set(group.files.map(f => f.parentDir))];

  // Check each directory for well-known cover files
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch { continue; }

    const lowerMap = new Map(entries.map(f => [f.toLowerCase(), f]));

    // Well-known cover files
    for (const name of COVER_NAMES) {
      const actual = lowerMap.get(name);
      if (actual) {
        try {
          const data = await readFile(path.join(dir, actual));
          const mime = mimeFromExt(path.extname(actual));
          const result = await writeArt(ART_DIR, data, mime);
          return result.relPath;
        } catch { /* fall through */ }
      }
    }

    // Any image file
    const imageFile = entries.find(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
    if (imageFile) {
      try {
        const data = await readFile(path.join(dir, imageFile));
        const mime = mimeFromExt(path.extname(imageFile));
        const result = await writeArt(ART_DIR, data, mime);
        return result.relPath;
      } catch { /* fall through */ }
    }
  }

  // Embedded art from the first file with art data
  const fileWithArt = group.files.find(f => f.artData && f.artMime);
  if (fileWithArt?.artData && fileWithArt.artMime) {
    try {
      const result = await writeArt(ART_DIR, fileWithArt.artData, fileWithArt.artMime);
      return result.relPath;
    } catch { /* ignore */ }
  }

  return null;
}

// ── Step 4: Upsert audiobook + chapters ─────────────────────

async function upsertAudiobook(group: AudiobookGroup, coverPath: string | null): Promise<{
  chapterCount: number;
  totalDurationMs: number;
}> {
  let totalDurationMs = 0;
  let allDurationsKnown = true;

  for (const f of group.files) {
    if (f.durationMs != null) totalDurationMs += f.durationMs;
    else allDurationsKnown = false;
  }
  if (!allDurationsKnown) totalDurationMs = 0;

  // Upsert audiobook (key is the stable grouping key)
  const { rows } = await db().query<{ id: number }>(
    `INSERT INTO audiobooks (path, title, author, narrator, language, cover_path, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (path) DO UPDATE SET
       title = CASE WHEN audiobooks.metadata_locked THEN audiobooks.title ELSE EXCLUDED.title END,
       author = CASE WHEN audiobooks.metadata_locked THEN audiobooks.author ELSE EXCLUDED.author END,
       narrator = CASE WHEN audiobooks.metadata_locked THEN audiobooks.narrator ELSE EXCLUDED.narrator END,
       language = CASE WHEN audiobooks.metadata_locked THEN audiobooks.language ELSE EXCLUDED.language END,
       cover_path = EXCLUDED.cover_path, duration_ms = EXCLUDED.duration_ms,
       updated_at = now()
     RETURNING id`,
    [group.key, group.title, group.author, group.narrator, group.language, coverPath, totalDurationMs],
  );
  const audiobookId = rows[0].id;

  // Upsert chapters (path = absolute file path)
  for (let i = 0; i < group.files.length; i++) {
    const f = group.files[i];
    const chapterTitle = f.title || path.basename(f.filename, path.extname(f.filename));

    await db().query(
      `INSERT INTO audiobook_chapters (audiobook_id, path, title, position, duration_ms, size_bytes, mtime_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (audiobook_id, path) DO UPDATE SET
         title = CASE WHEN audiobook_chapters.metadata_locked THEN audiobook_chapters.title ELSE EXCLUDED.title END,
         position = EXCLUDED.position,
         duration_ms = EXCLUDED.duration_ms, size_bytes = EXCLUDED.size_bytes,
         mtime_ms = EXCLUDED.mtime_ms`,
      [audiobookId, f.absolutePath, chapterTitle, i, f.durationMs, f.sizeBytes, f.mtimeMs],
    );
  }

  // Remove stale chapters no longer on disk
  const currentPaths = group.files.map(f => f.absolutePath);
  await db().query(
    `DELETE FROM audiobook_chapters WHERE audiobook_id = $1 AND path != ALL($2::text[])`,
    [audiobookId, currentPaths],
  );

  return { chapterCount: group.files.length, totalDurationMs };
}

// ── Main entry point ────────────────────────────────────────

export async function scanAudiobooks(audiobookDirs: string[]): Promise<void> {
  const startedAt = Date.now();
  logger.info('audiobook-scan', `Starting smart audiobook scan across ${audiobookDirs.length} director${audiobookDirs.length === 1 ? 'y' : 'ies'}`);

  // Step 1: Collect all audio files
  const allFiles = await collectAllAudioFiles(audiobookDirs);
  logger.info('audiobook-scan', `Found ${allFiles.length} audio files`);

  if (allFiles.length === 0) {
    await db().query(`DELETE FROM audiobooks`);
    logger.info('audiobook-scan', 'No audio files found — cleared all audiobooks');
    return;
  }

  // Step 2: Group into audiobooks
  const groups = groupFilesIntoAudiobooks(allFiles);
  logger.info('audiobook-scan', `Grouped into ${groups.length} audiobook${groups.length === 1 ? '' : 's'}`);

  // Step 3 & 4: Process each group
  let totalChapters = 0;
  let totalDurationMs = 0;
  const validKeys = new Set<string>();

  for (const group of groups) {
    try {
      const coverPath = await detectGroupCover(group);
      const result = await upsertAudiobook(group, coverPath);
      validKeys.add(group.key);
      totalChapters += result.chapterCount;
      totalDurationMs += result.totalDurationMs;
    } catch (e) {
      logger.error('audiobook-scan', `Failed to process audiobook "${group.title}"`, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Remove stale audiobooks no longer matched
  if (validKeys.size > 0) {
    await db().query(
      `DELETE FROM audiobooks WHERE path != ALL($1::text[])`,
      [Array.from(validKeys)],
    );
  } else {
    await db().query(`DELETE FROM audiobooks`);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const durationHrs = (totalDurationMs / 3_600_000).toFixed(1);
  logger.success(
    'audiobook-scan',
    `Scan complete in ${elapsed}s — ${groups.length} audiobook${groups.length === 1 ? '' : 's'}, ${totalChapters} chapters, ${durationHrs}h total duration`,
  );
}

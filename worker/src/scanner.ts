import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import * as repo from './scanRepo.js';
import { readTags } from './metadata.js';

const LYRICS_DIR = process.env.LYRICS_DIR ?? '/data/cache/lyrics';

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav']);

export async function runScan(mountPath: string, musicDir: string, jobId: number) {
  const startedAt = Date.now();
  let scannedFiles = 0;
  let upserted = 0;
  let skipped = 0;
  let parsed = 0;
  let parseFailed = 0;

  const stack: string[] = [musicDir];

  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;

      const ext = path.extname(e.name).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) {
        skipped++;
        continue;
      }

      const st = await stat(full);
      scannedFiles++;

      // store paths relative to MUSIC_DIR for portability
      const rel = path.relative(musicDir, full);

      const baseNoExtRel = rel.replace(/\.[^./\\]+$/, '');
      const lyricsRel = `${baseNoExtRel}.lrc`;
      const lyricsAbs = path.join(LYRICS_DIR, lyricsRel);
      let lyricsPath: string | null = null;
      try {
        const lst = await stat(lyricsAbs);
        if (lst.isFile()) lyricsPath = lyricsRel;
      } catch {
        // no lyrics
      }

      const existing = await repo.getTrackByPath(mountPath, rel);
      const skipParsing = existing && existing.mtime_ms === Math.round(st.mtimeMs) && existing.size_bytes === st.size && existing.ext === ext && !process.env.SCAN_REFRESH_META;
      if (skipParsing) {
        await repo.markSeen(jobId, mountPath, rel, lyricsPath);
        continue;
      }

      let tags: {
        title: string | null;
        artist: string | null;
        album: string | null;
        albumartist: string | null;
        genre: string | null;
        country: string | null;
        language: string | null;
        year: number | null;
        durationMs: number | null;
        artMime: string | null;
        artData: Uint8Array | null;
        artists: string[];
        albumartists: string[];
      } = {
        title: null,
        artist: null,
        album: null,
        albumartist: null,
        genre: null,
        country: null,
        language: null,
        year: null,
        durationMs: null,
        artMime: null,
        artData: null,
        artists: [],
        albumartists: []
      };

      try {
        tags = await readTags(full);
        parsed++;
      } catch {
        parseFailed++;
      }

      const artDir = process.env.ART_DIR ?? '/data/cache/art';
      let art: { relPath: string; mime: string; hash: string } | null = null;
      if (tags.artData && tags.artMime) {
        try {
          const { writeArt } = await import('./art.js');
          const w = await writeArt(artDir, tags.artData, tags.artMime);
          art = { relPath: w.relPath, mime: w.mime, hash: w.hash };
        } catch {
          // ignore art failures
        }
      }

      try {
        await repo.upsertTrack({
          jobId,
          mountPath,
          path: rel,
          mtimeMs: Math.round(st.mtimeMs),
          sizeBytes: st.size,
          ext,
          title: tags.title,
          artist: tags.artist,
          album: tags.album,
          albumartist: tags.albumartist,
          genre: tags.genre,
          country: tags.country,
          language: tags.language,
          year: tags.year,
          durationMs: tags.durationMs,
          artPath: art?.relPath ?? null,
          artMime: art?.mime ?? null,
          artHash: art?.hash ?? null,
          lyricsPath,
          artists: tags.artists,
          albumArtists: tags.albumartists
        });
      } catch (e) {
        // Log but don't fail on individual track errors
        console.warn('[scanner] upsertTrack failed for', rel, e instanceof Error ? e.message : String(e));
      }
      upserted++;
    }
  }

  const durationMs = Date.now() - startedAt;
  return { scannedFiles, upserted, skipped, parsed, parseFailed, durationMs };
}

import logger from './logger.js';

const LRCLIB_API = 'https://lrclib.net/api/get';
const MAX_LYRICS_BYTES = 512 * 1024;

export type LyricsCandidate = {
  text: string;
  synced: boolean;
  source: 'lrclib';
};

function validLyrics(value: unknown) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length < 10 || Buffer.byteLength(text, 'utf8') > MAX_LYRICS_BYTES) return null;
  return text;
}

export async function fetchLrclibLyrics(
  artist: string,
  title: string,
  album?: string | null,
  durationMs?: number | null,
): Promise<LyricsCandidate | null> {
  const cleanArtist = artist.trim();
  const cleanTitle = title.trim();
  if (!cleanArtist || !cleanTitle) return null;

  try {
    const params = new URLSearchParams({
      artist_name: cleanArtist,
      track_name: cleanTitle,
    });
    if (album?.trim()) params.set('album_name', album.trim());
    if (durationMs && Number.isFinite(durationMs) && durationMs > 0) {
      params.set('duration', String(Math.round(durationMs / 1000)));
    }

    const response = await fetch(`${LRCLIB_API}?${params}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'mvbar/1.0 (https://github.com/mariof1/mvbar)' },
    });
    if (!response.ok) return null;

    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_LYRICS_BYTES * 2) return null;
    const data = JSON.parse(body) as { syncedLyrics?: unknown; plainLyrics?: unknown };

    const synced = validLyrics(data.syncedLyrics);
    if (synced) return { text: synced, synced: true, source: 'lrclib' };

    const plain = validLyrics(data.plainLyrics);
    if (plain) return { text: plain, synced: false, source: 'lrclib' };

    return null;
  } catch (error) {
    logger.debug('lyrics', `LRCLIB lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

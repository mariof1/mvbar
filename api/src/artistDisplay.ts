export type ArtistCredit = {
  id?: number;
  name: string;
};

const ARTIST_VALUE_SEPARATOR = /\s*(?:;|\||•|\0|\uFEFF)\s*/;

/**
 * Convert the canonical semicolon-separated database value (and older pipe
 * variants) into the one presentation format shared by every client.
 * Commas, ampersands, and bare slashes are intentionally left untouched.
 */
export function artistNamesFromValue(value: unknown): string[] {
  if (typeof value !== 'string') return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of value.split(ARTIST_VALUE_SEPARATOR)) {
    const name = part.trim().replace(/\s+/g, ' ');
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function artistDisplayFromNames(names: string[]): string | null {
  const normalized = artistNamesFromValue(names.join('; '));
  return normalized.length ? normalized.join(' • ') : null;
}

export function artistDisplay(
  value: unknown,
  fallback?: unknown,
): string {
  const names = artistNamesFromValue(value);
  if (names.length) return names.join(' • ');

  const fallbackNames = artistNamesFromValue(fallback);
  return fallbackNames.length ? fallbackNames.join(' • ') : 'Unknown Artist';
}

export function trackArtistDisplay(
  credits: ArtistCredit[] | undefined,
  artist: unknown,
  albumArtist?: unknown,
): string {
  const names = credits?.map((credit) => credit.name) ?? [];
  return artistDisplayFromNames(names) ?? artistDisplay(artist, albumArtist);
}


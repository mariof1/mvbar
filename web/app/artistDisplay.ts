export type ArtistLike = {
  artist?: string | null;
  display_artist?: string | null;
  artists?: Array<{ name: string }> | null;
};

const ARTIST_VALUE_SEPARATOR = /\s*(?:;|\||•|\0|\uFEFF)\s*/;

export function formatArtistValue(value: string | null | undefined): string | null {
  if (!value) return null;

  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of value.split(ARTIST_VALUE_SEPARATOR)) {
    const name = part.trim().replace(/\s+/g, ' ');
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names.length ? names.join(' • ') : null;
}

export function trackArtistLabel(track: ArtistLike): string {
  const relationNames = track.artists
    ?.map((artist) => artist.name.trim())
    .filter(Boolean);
  if (relationNames?.length) return formatArtistValue(relationNames.join('; '))!;

  return formatArtistValue(track.display_artist)
    ?? formatArtistValue(track.artist)
    ?? 'Unknown Artist';
}


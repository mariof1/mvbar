import path from 'node:path';

export const DEEZER_SOURCE_PLUGIN_ID = 'mvbar.missing-music';

export function configuredMusicRoots(env: NodeJS.ProcessEnv) {
  const regular = [...new Set((env.MUSIC_DIRS ?? env.MUSIC_DIR ?? '/music')
    .split(',').map(value => value.trim()).filter(Boolean))];
  const requested = env.DEEZER_DOWNLOAD_DIR?.trim();
  const staging = requested ? path.resolve(requested) : null;
  // Overlapping roots would index the same files twice and misattribute their source.
  const overlaps = staging && regular.some(root => {
    const relative = path.relative(path.resolve(root), staging);
    const reverse = path.relative(staging, path.resolve(root));
    const inside = (value: string) => !value || (!value.startsWith('..' + path.sep) && value !== '..' && !path.isAbsolute(value));
    return inside(relative) || inside(reverse);
  });
  return {
    directories: overlaps || !staging ? regular : [...regular, staging],
    stagingDirectory: overlaps ? null : staging,
    overlap: Boolean(overlaps),
  };
}

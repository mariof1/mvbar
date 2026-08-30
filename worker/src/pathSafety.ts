import path from 'node:path';

export function resolveInside(baseDir: string, relativePath: string, allowBase = false) {
  if (relativePath.split(/[\\/]/).includes('..')) {
    throw new Error('invalid path');
  }

  const base = path.resolve(baseDir);
  const absolute = path.resolve(base, relativePath);
  const relative = path.relative(base, absolute);
  const escapesBase =
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);

  if (escapesBase || (!allowBase && relative === '')) {
    throw new Error('invalid path');
  }

  return absolute;
}

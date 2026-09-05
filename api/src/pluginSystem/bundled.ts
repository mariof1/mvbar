import fs from 'node:fs/promises';
import { parsePluginPackage } from './package.js';

export const BUNDLED_MISSING_MUSIC_KEY = 'missing-music';

const BUNDLED_PLUGINS = {
  [BUNDLED_MISSING_MUSIC_KEY]: {
    filename: 'mvbar-missing-music.ndp',
  },
} as const;

export type BundledPluginKey = keyof typeof BUNDLED_PLUGINS;

export function isBundledPluginKey(value: string): value is BundledPluginKey {
  return Object.hasOwn(BUNDLED_PLUGINS, value);
}

export async function getBundledPluginPackage(key: BundledPluginKey) {
  const definition = BUNDLED_PLUGINS[key];
  const packageUrl = new URL(`./bundled/${definition.filename}`, import.meta.url);
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(packageUrl);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // TypeScript development runs modules directly from src/, while production
    // builds copy the same package beside the compiled module in dist/.
    buffer = await fs.readFile(new URL(`../../assets/plugins/${definition.filename}`, import.meta.url));
  }
  const parsed = await parsePluginPackage(buffer, definition.filename);
  return { key, buffer, parsed };
}

export async function listBundledPluginPackages() {
  return Promise.all((Object.keys(BUNDLED_PLUGINS) as BundledPluginKey[]).map(getBundledPluginPackage));
}

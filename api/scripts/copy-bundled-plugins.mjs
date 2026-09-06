import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(apiRoot, 'assets', 'plugins', 'mvbar-missing-music.ndp');
const destinationDirectory = path.join(apiRoot, 'dist', 'pluginSystem', 'bundled');
const destination = path.join(destinationDirectory, 'mvbar-missing-music.ndp');

await fs.mkdir(destinationDirectory, { recursive: true });
await fs.copyFile(source, destination);

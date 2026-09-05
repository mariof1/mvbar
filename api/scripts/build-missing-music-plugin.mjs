import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const sourceDirectory = path.join(repositoryRoot, 'plugins', 'missing-music');
const outputDirectory = path.join(sourceDirectory, 'dist');
const outputPath = path.join(outputDirectory, 'mvbar-missing-music.ndp');
const bundledOutputDirectory = path.join(repositoryRoot, 'api', 'assets', 'plugins');
const bundledOutputPath = path.join(bundledOutputDirectory, 'mvbar-missing-music.ndp');

// A valid inert WebAssembly module. The feature is declarative: MVBar supplies
// the constrained catalog/request host capability only for this extension type.
const wasm = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x0e, 0x01, 0x0a,
  0x6d, 0x76, 0x62, 0x61, 0x72, 0x5f, 0x74, 0x65, 0x73, 0x74,
  0x00, 0x00,
  0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
]);

await fs.mkdir(outputDirectory, { recursive: true });
const archive = new ZipArchive({ zlib: { level: 9 } });
const chunks = [];
archive.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
const complete = new Promise((resolve, reject) => {
  archive.on('end', resolve);
  archive.on('error', reject);
});
archive.append(await fs.readFile(path.join(sourceDirectory, 'manifest.json')), { name: 'manifest.json' });
archive.append(wasm, { name: 'plugin.wasm' });
await archive.finalize();
await complete;
const packageBuffer = Buffer.concat(chunks);
await fs.writeFile(outputPath, packageBuffer);
await fs.mkdir(bundledOutputDirectory, { recursive: true });
await fs.writeFile(bundledOutputPath, packageBuffer);
console.log(outputPath);
console.log(bundledOutputPath);

import assert from 'node:assert/strict';
import test from 'node:test';
import { ZipArchive } from 'archiver';
import { parsePluginPackage } from '../dist/pluginSystem/package.js';
import { hostMatchesPattern } from '../dist/pluginSystem/runtime.js';

const MINIMAL_WASM = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x0e, 0x01, 0x0a,
  0x6d, 0x76, 0x62, 0x61, 0x72, 0x5f, 0x74, 0x65, 0x73, 0x74,
  0x00, 0x00,
  0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
]);

async function createPackage(manifest, wasm = MINIMAL_WASM) {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks = [];
  archive.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const complete = new Promise((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  archive.append(JSON.stringify(manifest), { name: 'manifest.json' });
  archive.append(wasm, { name: 'plugin.wasm' });
  await archive.finalize();
  await complete;
  return Buffer.concat(chunks);
}

test('parses a valid .ndp package and discovers exports', async () => {
  const buffer = await createPackage({
    id: 'example.tools',
    name: 'Example Tools',
    author: 'MVBar Test',
    version: '1.0.0',
    permissions: { http: { requiredHosts: ['api.example.com'] } },
  });
  const parsed = await parsePluginPackage(buffer, 'example.ndp');
  assert.equal(parsed.id, 'example.tools');
  assert.deepEqual(parsed.exports, ['mvbar_test']);
  assert.equal(parsed.packageSha256.length, 64);
  assert.equal(parsed.permissionFingerprint.length, 64);
});

test('rejects invalid package extensions and manifests', async () => {
  const buffer = await createPackage({ name: 'Missing fields' });
  await assert.rejects(() => parsePluginPackage(buffer, 'example.zip'), /\.ndp extension/);
  await assert.rejects(() => parsePluginPackage(buffer, 'example.ndp'), /field author is required/);
});

test('rejects unsafe links and malformed configuration schemas', async () => {
  const unsafeLink = await createPackage({
    id: 'example.unsafe-link',
    name: 'Unsafe link',
    author: 'MVBar Test',
    version: '1.0.0',
    homepage: 'javascript:alert(1)',
  });
  await assert.rejects(() => parsePluginPackage(unsafeLink, 'unsafe-link.ndp'), /must use HTTP/);

  const malformedSchema = await createPackage({
    id: 'example.bad-schema',
    name: 'Bad schema',
    author: 'MVBar Test',
    version: '1.0.0',
    config: { schema: { type: 'object', properties: { apiToken: null } } },
  });
  await assert.rejects(() => parsePluginPackage(malformedSchema, 'bad-schema.ndp'), /apiToken must be an object/);
});

test('host matching does not let wildcard suffixes escape their domain', () => {
  assert.equal(hostMatchesPattern('api.example.com', 'api.example.com'), true);
  assert.equal(hostMatchesPattern('music.example.com', '*.example.com'), true);
  assert.equal(hostMatchesPattern('example.com', '*.example.com'), false);
  assert.equal(hostMatchesPattern('evilexample.com', '*.example.com'), false);
  assert.equal(hostMatchesPattern('10.10.100.5', '*'), true);
});

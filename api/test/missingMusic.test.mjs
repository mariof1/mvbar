import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {
  isPrivateNetworkAddress,
  normalizeCatalogText,
  sameProviderOrigin,
  validateMissingMusicConfig,
} from '../dist/pluginSystem/missingMusic.js';
import { parsePluginPackage } from '../dist/pluginSystem/package.js';

test('the bundled Missing Music package is a valid request-only extension', async () => {
  const packageUrl = new URL('../../plugins/missing-music/dist/mvbar-missing-music.ndp', import.meta.url);
  const parsed = await parsePluginPackage(await fs.readFile(packageUrl), 'mvbar-missing-music.ndp');
  assert.equal(parsed.id, 'mvbar.missing-music');
  assert.equal(parsed.manifest.mvbar.extension.type, 'missing-music');
  assert.equal('storage' in parsed.manifest.permissions, false);
  assert.equal('http' in parsed.manifest.permissions, false);
});

test('catalog text normalization handles punctuation and accents', () => {
  assert.equal(normalizeCatalogText('Beyoncé — Live!'), 'beyonce live');
  assert.equal(normalizeCatalogText('  Album (Deluxe)  '), 'album deluxe');
});

test('private network detection covers loopback, RFC1918, link-local, and IPv6 ULA', () => {
  for (const address of ['127.0.0.1', '10.10.100.4', '172.16.0.1', '192.168.1.2', '169.254.1.1', '::1', 'fd00::1']) {
    assert.equal(isPrivateNetworkAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateNetworkAddress(address), false, address);
  }
});

test('provider origin matching does not allow sibling hosts or ports', () => {
  const base = new URL('https://requests.example.com/base/');
  assert.equal(sameProviderOrigin(base, new URL('https://requests.example.com/v1/requests')), true);
  assert.equal(sameProviderOrigin(base, new URL('https://api.example.com/v1/requests')), false);
  assert.equal(sameProviderOrigin(base, new URL('https://requests.example.com:8443/v1/requests')), false);
});

test('private request providers need the explicit administrator option', async () => {
  await assert.rejects(
    () => validateMissingMusicConfig({ providerBaseUrl: 'http://10.10.100.50:6595' }),
    /explicit private-network option/,
  );
  await assert.doesNotReject(
    () => validateMissingMusicConfig({ providerBaseUrl: 'http://10.10.100.50:6595', allowPrivateProvider: true }),
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {
  isPrivateNetworkAddress,
  normalizeCatalogText,
  normalizeLocalAlbumTitle,
  songIsPresent,
  songMatchKey,
  songSearchQuery,
  standardSongRelease,
  sameProviderOrigin,
  validateMissingMusicConfig,
} from '../dist/pluginSystem/missingMusic.js';

test('song search prefers main albums, then EPs and singles, excluding alternate recordings', () => {
  const release = (type, secondary = [], status = 'Official') => ({ title: type, status, 'release-group': { 'primary-type': type, 'secondary-types': secondary } });
  const album = release('Album');
  const ep = release('EP');
  const single = release('Single');
  const releases = [single, release('Album', ['Compilation']), ep, album];
  assert.equal(standardSongRelease({ title: 'Live Forever', releases }), album);
  assert.equal(standardSongRelease({ releases: [single, ep] }), ep);
  assert.equal(standardSongRelease({ releases: [single] }), single);
  for (const disambiguation of ['live, 1985 Wembley', 'demo', 'radio edit', 'acoustic version', 'club remix', 'karaoke']) {
    assert.equal(standardSongRelease({ disambiguation, releases }), undefined);
  }
  assert.equal(standardSongRelease({ title: 'Song (Live at Wembley)', releases }), undefined);
  assert.equal(standardSongRelease({ title: 'Song - Extended Remix', releases }), undefined);
  assert.equal(standardSongRelease({ video: true, releases }), undefined);
  assert.equal(standardSongRelease({ releases: [release('Album', ['Live']), release('Album', [], 'Bootleg')] }), undefined);
  assert.equal(standardSongRelease({ releases: [] }), undefined);
  assert.match(songSearchQuery('Song'), /status:official/);
});

test('song matching handles tags, accents, non-Latin names and different performers', () => {
  assert.equal(songMatchKey('Beyoncé!'), 'beyonce');
  assert.equal(songMatchKey('世界'), '世界');
  const song = { recordingId: 'recording', title: 'Song', artistNames: ['Artist'] };
  assert.equal(songIsPresent(song, [{ title: 'Different', artist: null, musicbrainz_track_id: 'recording' }]), true);
  assert.equal(songIsPresent(song, [{ title: 'SONG!', artist: 'Artist', musicbrainz_track_id: null }]), true);
  assert.equal(songIsPresent(song, [{ title: 'Song', artist: 'Cover artist', musicbrainz_track_id: null }]), false);
  assert.match(songSearchQuery('Song Artist'), /recording:"Song" OR artist:"Song"/);
  assert.match(songSearchQuery('" OR *'), /\\"/);
});
import { parsePluginPackage } from '../dist/pluginSystem/package.js';
import {
  getBundledPluginPackage,
  listBundledPluginPackages,
  parsePluginRegistry,
} from '../dist/pluginSystem/bundled.js';

test('the bundled Missing Music package is a valid request-only extension', async () => {
  const packageUrl = new URL('../assets/plugins/mvbar-missing-music.ndp', import.meta.url);
  const parsed = await parsePluginPackage(await fs.readFile(packageUrl), 'mvbar-missing-music.ndp');
  assert.equal(parsed.id, 'mvbar.missing-music');
  assert.equal(parsed.manifest.mvbar.extension.type, 'missing-music');
  assert.equal(parsed.manifest.version, '1.1.0');
  assert.match(parsed.manifest.config.schema.properties.excludedSecondaryTypes.default, /Compilation/);
  assert.equal('storage' in parsed.manifest.permissions, false);
  assert.equal('http' in parsed.manifest.permissions, false);
});

test('the Missing Music package is bundled into production builds for one-click installation', async () => {
  const bundled = await getBundledPluginPackage('missing-music', { bundledOnly: true });
  assert.equal(bundled.parsed.id, 'mvbar.missing-music');
  assert.equal(bundled.parsed.manifest.version, '1.1.0');
  assert.ok(bundled.buffer.length > 100);
  assert.deepEqual((await listBundledPluginPackages()).map((plugin) => plugin.key), ['missing-music']);
});

test('the official plugin registry requires checksums and same-origin package URLs', () => {
  const source = new URL('https://plugins.example.test/registry.json');
  const entry = {
    key: 'example',
    id: 'mvbar.example',
    name: 'Example',
    version: '1.0.0',
    filename: 'example.ndp',
    packageUrl: 'https://plugins.example.test/example.ndp',
    sha256: 'a'.repeat(64),
    size: 1_024,
  };
  assert.equal(parsePluginRegistry({ schemaVersion: 1, plugins: [entry] }, source).plugins[0].id, 'mvbar.example');
  assert.throws(
    () => parsePluginRegistry({ schemaVersion: 1, plugins: [{ ...entry, packageUrl: 'https://elsewhere.example/example.ndp' }] }, source),
    /registry origin/,
  );
  assert.throws(
    () => parsePluginRegistry({ schemaVersion: 1, plugins: [{ ...entry, sha256: 'invalid' }] }, source),
    /Checksum/,
  );
});

test('catalog text normalization handles punctuation and accents', () => {
  assert.equal(normalizeCatalogText('Beyoncé — Live!'), 'beyonce live');
  assert.equal(normalizeCatalogText('  Album (Deluxe)  '), 'album deluxe');
});

test('local album normalization ignores edition metadata without changing real titles', () => {
  assert.equal(
    normalizeLocalAlbumTitle('Muzyka Współczesna Extended'),
    normalizeCatalogText('Muzyka współczesna'),
  );
  assert.equal(normalizeLocalAlbumTitle('Album (Deluxe Edition)'), 'album');
  assert.equal(normalizeLocalAlbumTitle('Album – 2024 Remaster'), 'album');
  assert.equal(normalizeLocalAlbumTitle('Album (Disc 2)'), 'album');
  assert.equal(normalizeLocalAlbumTitle('Extended Play'), 'extended play');
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

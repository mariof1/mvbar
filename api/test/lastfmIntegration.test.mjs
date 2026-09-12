import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lastfmApiSignature,
  lastfmSubmissionArtist,
  matchLovedTracks,
  selectLovedTrackMatches,
  syncUserTrackLoved,
} from '../dist/lastfmIntegration.js';

test('Last.fm signatures sort parameters and omit response-only fields', () => {
  const signature = lastfmApiSignature({
    token: 'xxxxxxx',
    method: 'auth.getSession',
    format: 'json',
    callback: 'https://example.test/callback',
    api_key: 'xxxxxxxx',
  }, 'mysecret');

  assert.equal(signature, '68afb32bee072407a63b6c41f3e1e2b4');
});

test('Last.fm loved tracks match normalized titles and credited artists', () => {
  const matches = selectLovedTrackMatches(
    [
      { title: '  My   Song ', artist: 'THE ARTIST' },
      { title: 'Collaboration', artist: 'Guest Artist' },
      { title: 'Same title', artist: 'Right Artist' },
    ],
    [
      { id: 9, title: 'My Song', artist: 'The Artist', album: null, creditedArtists: ['The Artist'] },
      { id: 4, title: 'My Song', artist: 'The Artist', album: 'Main Album', creditedArtists: ['The Artist'] },
      { id: 6, title: 'Collaboration', artist: 'Lead Artist; Guest Artist', album: 'Together', creditedArtists: ['Lead Artist', 'Guest Artist'] },
      { id: 7, title: 'Same title', artist: 'Wrong Artist', album: 'Wrong Album', creditedArtists: ['Wrong Artist'] },
    ],
  );

  assert.deepEqual(matches, [4, 6]);
});

test('Last.fm loved-track matching tolerates tag punctuation, accents and trailing credits', () => {
  const matches = selectLovedTrackMatches(
    [
      { title: 'Nisko jest niebo (prod. Auer)', artist: 'Pezet; Kayah' },
      { title: 'Me gustas tú', artist: 'Manu Chao' },
      { title: 'Mirek', artist: 'Marysia Starosta; Sokół' },
      { title: 'Owner of a Lonely Heart (Radio Edit)', artist: 'Max Graham / Yes' },
      { title: 'Same title', artist: 'Missing Artist' },
    ],
    [
      { id: 1, title: 'Nisko jest Niebo', artist: 'Pezet', album: 'Album', creditedArtists: ['Pezet'] },
      { id: 2, title: 'Me Gustas Tu', artist: 'Manu Chao', album: 'Album', creditedArtists: ['Manu Chao'] },
      { id: 3, title: 'Mirek', artist: 'Sokół; Marysia Starosta', album: 'Album', creditedArtists: ['Sokół', 'Marysia Starosta'] },
      { id: 4, title: 'Owner of a Lonely Heart (Radio Edit)', artist: 'Max Graham; Yes', album: 'Album', creditedArtists: ['Max Graham', 'Yes'] },
      { id: 5, title: 'Same title', artist: 'Different Artist', album: 'Album', creditedArtists: ['Different Artist'] },
    ],
  );

  assert.deepEqual(matches, [1, 2, 3, 4]);
});

test('Last.fm loved-track matching handles bare features and exact-title artist components', () => {
  const matches = selectLovedTrackMatches(
    [
      { title: 'Skamieniali (+ Teka)', artist: 'Trzeci Wymiar' },
      { title: 'Niepokój ft. Melny', artist: 'Małolat' },
      { title: 'Szósty Zmysł', artist: 'Pezet-Noon' },
      { title: 'Bezkrólewie', artist: 'Sebastian Fabijański' },
      { title: 'Different Song', artist: 'Sebastian Fabijański' },
    ],
    [
      { id: 10, title: 'Skamieniali', artist: 'Trzeci Wymiar', album: 'Album', creditedArtists: ['Trzeci Wymiar'] },
      { id: 11, title: 'Niepokój', artist: 'Małolat; MELNY', album: 'Album', creditedArtists: ['Małolat', 'MELNY'] },
      { id: 12, title: 'Szósty Zmysł', artist: 'Pezet', album: 'Album', creditedArtists: ['Pezet'] },
      { id: 13, title: 'Bezkrólewie', artist: 'Fabijański', album: 'Album', creditedArtists: ['Fabijański'] },
      { id: 14, title: 'Different Song (Remix)', artist: 'Fabijański', album: 'Album', creditedArtists: ['Fabijański'] },
    ],
  );

  assert.deepEqual(matches, [10, 11, 12, 13]);
});

test('Last.fm submissions use the primary credited artist without splitting real artist names', () => {
  assert.equal(lastfmSubmissionArtist('The Buggles; Trevor Horn; Geoff Downes'), 'The Buggles');
  assert.equal(lastfmSubmissionArtist('Earth, Wind & Fire'), 'Earth, Wind & Fire');
});

test('rapid Last.fm love changes are coalesced to the latest requested state', async () => {
  const calls = [];
  const submitter = async (_userId, _track, loved) => {
    calls.push(loved);
    return { submitted: true };
  };
  const track = { title: 'Race Test', artist: 'Test Artist' };

  const add = syncUserTrackLoved('queue-test-user', 123, track, true, submitter);
  const remove = syncUserTrackLoved('queue-test-user', 123, track, false, submitter);
  await Promise.all([add, remove]);

  assert.deepEqual(calls, [false]);
});

test('a Last.fm change arriving during submission is sent afterward', async () => {
  const calls = [];
  let releaseFirst;
  let markStarted;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  const firstStarted = new Promise(resolve => { markStarted = resolve; });
  const submitter = async (_userId, _track, loved) => {
    calls.push(loved);
    if (calls.length === 1) {
      markStarted();
      await firstBlocked;
    }
    return { submitted: true };
  };
  const track = { title: 'In-flight Test', artist: 'Test Artist' };

  const add = syncUserTrackLoved('in-flight-test-user', 456, track, true, submitter);
  await firstStarted;
  const remove = syncUserTrackLoved('in-flight-test-user', 456, track, false, submitter);
  releaseFirst();
  await Promise.all([add, remove]);

  assert.deepEqual(calls, [true, false]);
});

test('Last.fm sync counts tag variants as matched while importing one local file', () => {
  const result = matchLovedTracks(
    [
      { title: 'A Song', artist: 'An Artist' },
      { title: 'A Song (prod. Someone)', artist: 'An Artist' },
    ],
    [
      { id: 50, title: 'A Song', artist: 'An Artist', album: 'Album', creditedArtists: ['An Artist'] },
    ],
  );

  assert.deepEqual(result, { trackIds: [50], matched: 2 });
});

# Main app audit log

## 2026-09-15

The autonomous audit now covers only the MVBar web app and its API on `dev`. Android, Android Auto, TV, Wear and emulator checks are excluded.

Confirmed issue: the mobile full-player song title had become a plain `div` when scrolling titles were introduced. This removed the title's heading semantics and left the touch/mouse queue gesture regression test unable to locate its drag starting point. Wrapped the scrolling title in an `h2` while retaining the existing visual styling and scrolling behavior.

Verification: the current local server on port 8080 was healthy. Three live-server browser tests passed for failed favourite updates and malformed browse routes. The two mobile player gesture tests timed out against the older server build because the heading was absent. An isolated production preview built from the updated web source passed both touch and mouse queue gestures, including expand, select, return, and minimize. Thirteen additional preview tests passed for artist/album lazy loading at 1280px and 390px, small-screen search and confirmation dialogs, and MVBar Connect seeking, transfers, and stale player snapshots. TypeScript and targeted ESLint passed. The preview emitted a Windows symlink warning while collecting standalone traces; its Next build and tests still completed successfully.

Next coverage: authenticated web-to-web Connect playback and queue transfer with real players, podcast/audiobook resume and seeking, Last.fm love/scrobble timing, and 4K side-card browsing. Use isolated players and avoid disturbing active playback.

### Follow-up: Last.fm submissions and wide browsing

Confirmed mismatch: love/unlove submissions already use the primary credited artist, while now-playing and scrobble submissions sent the full stored artist value. For a credit list such as `The Buggles; Trevor Horn; Geoff Downes`, the same track would be submitted under different artist names. Last.fm requires an artist name for [now-playing](https://www.last.fm/api/show/track.updateNowPlaying) and [scrobbles](https://www.last.fm/api/show/track.scrobble); the likely profile mismatch is an inference from those requirements and the submitted values. Changed now-playing and scrobble to use the existing primary-artist helper. API build, targeted ESLint and all eight Last.fm unit tests passed. No live Last.fm write was sent to the user's account.

Added an isolated wide-screen browser regression check at 2560px: opening an artist album renders its tracks in the details card, leaves the artist results and route in place, and returns to the album selection without reloading the browse list. The test, web TypeScript and targeted ESLint passed. Real 4K library browsing and authenticated web-to-web Connect remain to be checked. Also inspect whether scrobble timestamps reflect the actual playback start time.

### Follow-up: scrobble start time

Confirmed issue: [Last.fm's scrobble API](https://www.last.fm/api/show/track.scrobble) requires the timestamp when the track started playing. The web player omitted `listenedAt`, so the API estimated start as submission time minus the entire track duration. The player submits at 80% after meaningful listening; seeking and pauses make that estimate inaccurate. The first playback event can also precede PlayerBar mounting, as documented in `musicAudio.ts`.

The persistent audio element now records the first successful playback attempt's start time across pauses and clears it on a new track, stop or failed attempt. PlayerBar captures that start even when it misses the initial event, and sends it with the Last.fm scrobble. A browser regression test simulates a one-minute pause and a seek before scrobbling: it failed against the pre-fix port 8080 build because no timestamp was sent and passed against an isolated updated production preview. The preview build, web TypeScript, targeted ESLint, two mobile queue-gesture tests, two favourites-refresh tests and ten Connect playback/edge-case tests passed. The isolated preview's Windows symlink trace warning did not prevent a successful build. No real Last.fm submission or library mutation was made.

The updated main web build was deployed to the local npm stack once its scan and playback were idle. The port 8080 health check and the pause/seek scrobble regression test passed after restart.

Next gaps: authenticated web-to-web Connect with isolated live players, real podcast/audiobook resume and seek, 4K library side-card behavior, and repeat-one listen/scrobble boundaries.

### Follow-up: repeat-one listen boundaries

Confirmed issue: after a song ended in repeat-one mode, PlayerBar sought to zero and replayed it without resetting its completed-listen latch or playback metrics. The shell also kept the same track ID in its history latch. The next full listen therefore produced neither a new play-history record nor a new Last.fm scrobble. An isolated browser test reproduced one history request and one scrobble across two completed cycles on the pre-fix local build.

At the repeat boundary, PlayerBar now resets its per-listen state and start timestamp, and the shell clears the same-track history latch. The test passed against an isolated updated production preview: two completed cycles yielded two history requests and two scrobbles. Web TypeScript, targeted ESLint, the preview build, and eight related Last.fm, mobile player and Connect tests passed. The preview emitted the same Windows symlink trace warning as prior runs, without a build failure. All API and websocket responses in these browser checks were isolated; no real account, playback history or media was changed.

After the library scan and player were idle, the updated main web build was deployed to the local npm stack. The repeat-one regression test passed against port 8080 after restart, and the in-app admin page recovered normally.

Next gaps: authenticated web-to-web Connect with isolated live players, real podcast/audiobook resume and seek, and real 4K library browsing.

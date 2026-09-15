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

### Follow-up: long-form player progress

Confirmed audiobook chapter-switch bug: the outgoing audio effect read a mutable chapter ref during cleanup. Switching from chapter 11 at 42 seconds submitted that position for chapter 12, corrupting the new chapter's resume position. A browser fixture reproduced the wrong chapter ID on the previously running local build. Audio lifecycle callbacks now retain their own chapter ID, and a completed async auto-advance is ignored if that chapter was changed or closed while the request was pending. Cleanup also avoids a redundant final progress save after the ended handler has saved it.

Confirmed podcast completion bug: the still-mounted player continued its five-second progress timer after an episode ended. It wrote `played: false` to the local progress store and broadcast, causing the episode to reappear in the In progress list even though the API completion request had marked it played. A browser fixture showed In progress returning after the timer. The timer now updates only during active playback.

Both browser regressions passed against an isolated updated production preview, along with the two mobile queue gestures and repeat-one history/scrobble regression. Web TypeScript and targeted ESLint passed. The preview had the known Windows symlink trace warning but built successfully. Fixture API and websocket requests were intercepted, so no real account or media progress was changed. Next gaps: actual podcast/audiobook resume and seek with isolated playback, authenticated web-to-web Connect, and real 4K side-card browsing.

The updated web build was deployed to the local npm stack after the admin page showed no active scan or playback. Port 8080 returned to ready, and both intercepted browser regressions passed against it.

### Follow-up: immediate podcast resume after pause or close

Confirmed issue: podcast progress was saved to the API only by the five-second timer, throttled to fifteen seconds. The global player supplies no final-progress callback, so a seek followed by pause or closing the player before the next timer tick lost the resume position. An isolated browser fixture closed an episode at 42 seconds on the previous local build and received no progress request.

The player now saves its current position on pause and cleanup, with a small keepalive request for a closing tab. It updates local and websocket progress at the same time, allowing an immediate reopen to resume at the saved position. The completed state is retained when replaying an already-played episode. The browser fixture passed against an isolated updated production preview: active close resumed at 42 seconds, pause resumed at 30 seconds, and an ended episode stayed out of In progress after the timer. The audiobook chapter-switch regression, web TypeScript, targeted ESLint and preview production build also passed. The preview emitted the known Windows symlink trace warning without a build failure. All test API and websocket traffic was isolated; no real account progress was altered.

After the admin page showed no scan or player activity, the main web build was deployed to the local npm stack. Port 8080 returned to ready, and the intercepted pause/close/resume/completion browser regression passed against it.

### Follow-up: audiobook chapter starts and skipped-time accounting

Confirmed issue: selecting the next audiobook chapter and immediately closing its player saved no position for that chapter because progress was sent only after ten seconds or after a nonzero position. The API still pointed to the old completed chapter for Continue Listening. An isolated browser fixture reproduced the missing zero-position update on the previous local build.

The web player now saves a chapter's initial position on its first successful play, including zero, and serializes per-book progress requests so a delayed old-chapter cleanup cannot overwrite the new chapter's resume state. A delayed-request browser regression passed against an updated production preview: the old chapter's 42-second save completed before the new chapter's zero-position update was sent. The related API previously inferred the unheard remainder of an old chapter as listening time whenever progress moved forward to a new chapter. It now counts only reported time in the new chapter; a unit test covers manual skips and contiguous listening.

The preview production build, web TypeScript and targeted ESLint passed. The API build, targeted ESLint and seven audiobook/media-activity tests passed. The preview's known Windows symlink trace warning did not block the build. The browser test intercepted all API and websocket traffic, so no real audiobook progress was changed.

After the local admin page showed no scan or player activity, the updated API and web builds were started on port 8080. The stack returned to ready and the delayed audiobook chapter-switch browser regression passed against it.

### Follow-up: 4K browse side-card scroll position

Confirmed issue: opening an artist details card on a 3840×2160 viewport remounted the main browse list and reset its scroll position from 350px to zero. Opening the album tracks kept the card and results route, but the artist selection visibly jumped back to the start. An isolated browser fixture reproduced the jump on the previous local build with 288 artists. It also checked that the visible 4K artist row filled before the card opened.

The browse list now remembers its scroll position by tab and restores it when the main list remounts for a details card or returns after closing it. Opening artist albums, then their tracks, keeps the main selection in place without an offset-zero refetch. The 4K browser regression passed against an isolated updated production preview, including closing the card. Five related wide-panel and 390/1280px lazy-loading tests passed, as did web TypeScript, targeted ESLint and the preview production build. The preview emitted its known Windows symlink trace warning without preventing a successful build. All API and websocket traffic in these tests was intercepted; actual authenticated 4K library browsing remains a coverage gap.

The updated web build was deployed to the local npm stack after the admin page showed no scan or player activity. Port 8080 returned to ready and the intercepted 4K side-card scroll regression passed against it.

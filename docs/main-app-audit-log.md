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

### Follow-up: Connect web player version

Confirmed mismatch: every web player registered with MVBar Connect as app version `0.1.0` even though the web package is `2.6.0`. A browser fixture reproduced the stale registration value on the previous local build. The Next build now injects the package version into the client registration; a development build can use `debug` if it has no injected version. This keeps the version advertised to other players aligned with the actual web build.

Sixteen existing Connect and browser-console checks passed on the local web build before the fix. The new version regression and thirteen related transfer, remote seek, queue-command and responsive Connect checks passed against an isolated updated production preview. Web TypeScript, targeted ESLint and the preview production build passed. The preview emitted the known Windows symlink trace warning without a build failure. All fixture API and websocket traffic was intercepted. An extra hidden in-app browser tab opened signed out and was closed without logging in; authenticated web-to-web transfer remains a coverage gap because that tab did not share the user's existing session.

The updated web build was deployed to the local npm stack while the admin page showed no scan or playback activity. Port 8080 returned to ready and the intercepted Connect registration-version browser regression passed against it.

### Follow-up: stale songs during a new search

The scheduled audit remains active every ten minutes for the main web app and API only. Eight live-server fixture checks passed for missing-song requests and smart playlist criteria/save behavior. A new search regression then confirmed that changing the search query left the prior song visible and clickable while the new quick lookup was pending. The browser fixture held the new response and still found the old song on the previously running port 8080 build.

Search now clears the prior song hits on a query change, alongside the other result categories already cleared. The regression and nine related missing-song, smart-picker, and AI-search tests passed against an isolated production preview. Web TypeScript, targeted ESLint, and production builds passed. Fixture API and websocket traffic were intercepted, so no account search history or media was changed. The isolated preview emitted the known Windows symlink trace warning without preventing the build.

Next gaps: authenticated web-to-web Connect with real isolated players, actual authenticated 4K browse side-card behavior, and other main-app search/playlist/player edge cases. Keep the Android repos and emulators outside this audit.

The updated web build was deployed to the local npm stack after the admin page showed no active scan or player. Port 8080 returned to ready, and the search regression, missing-song request checks, and smart criteria keyboard test passed against it. The restart began its normal library indexing cycle afterward; no scan action was triggered by the audit.

### Follow-up: favourites, playlist navigation, and browse failures

The next web-only audit pass found the local npm stack ready, `dev` clean and aligned with `origin/dev`, and no new failed Build & Release run. Fourteen isolated browser checks passed on port 8080: mouse and touch favourite reordering, keyboard moves and rollback, playback across paginated favourites, navigation away from delayed playlist requests, playlist menu placement on small viewports, and browse-list retry/pagination after failures. No confirmed product issue arose in those flows. The running app was left untouched during its normal post-restart library indexing cycle.

Continue with actual authenticated wide-screen artist/album side-card navigation or isolated authenticated web-to-web Connect when live player and scan state allow. Check untested unknown-album discovery and Recently Added behavior with read-only library queries; preserve uploaded media and tags.

### Follow-up: authenticated 4K browse and albumless discovery

The local stack was ready, `dev` clean and aligned with `origin/dev`, and the admin page showed no active scan. At a temporary 3840×2160 in-app browser viewport, the real authenticated artist list opened 2 Chainz in its details card; choosing *Dope Don't Sell Itself* rendered its track in the card while the main artist results and artist URL remained in place. The card's back control returned to album selection. The real Night Lovell artist selection listed five own albums, including *Unknown Album — Night Lovell*, and two Appears On entries; the albumless track opened from that unknown-album card. Recently Added also showed the unknown album near the top and opened the same track. No browser errors or warnings appeared during these flows. The in-app browser was returned to its original Admin page and default viewport without starting playback or modifying library data.

Authenticated web-to-web Connect with two independent active web players remains an audit gap. Continue with isolated accounts/players when feasible without disturbing the user's current session, then test other unvisited main-app areas such as downloads and account settings.

### Follow-up: profile/avatar changes across accounts

Confirmed account-scoping issue in web Settings: a delayed profile GET from a signed-out account applied its avatar to the newly signed-in account's global user state, and a delayed avatar DELETE similarly cleared the new account's sidebar avatar. Isolated browser fixtures reproduced both on the previously running port 8080 build. Each settings profile read/upload/delete now verifies that it still belongs to the active Settings account before updating the profile, global avatar, or notice. Starting a newer profile/avatar action invalidates any older pending profile read.

The two regressions and a separate late Last.fm integration-status account-switch check passed against an isolated updated production preview. Four existing account-preference isolation tests also passed. Web TypeScript, targeted ESLint and the preview production build passed; the preview had its known Windows symlink trace warning without a build failure. Fixture accounts, API responses and websockets were isolated, so no real user avatar or Last.fm connection was changed.

Next coverage: avatar upload error/retry and same-account concurrent actions, backup downloads, and authenticated two-player Connect when a separate web session can be safely established.

The updated web build was deployed after the local Admin page showed no active scan or player. Port 8080 returned to ready, and all three account-switch checks plus four preference-account checks passed against it. The restart began its normal library discovery scan afterward; the audit did not trigger or interrupt it.

### Follow-up: backup download errors

Confirmed main-app Admin issue: a stored backup missing from the server was downloaded through a direct cookie-authenticated link. The 404 API JSON replaced the entire Admin page, with no inline error. An isolated browser fixture reproduced the navigation on the prior port 8080 build. Cookie-based downloads now make a HEAD availability/access check first, report 404 and 403 in the backup panel, then use the existing browser attachment download for a valid large archive instead of buffering it in memory.

Both missing-backup and successful attachment checks passed against an isolated production preview and then the updated port 8080 build. The successful fixture observed HEAD followed by GET and the expected archive filename, while staying in Admin. Three profile-account regression checks, web TypeScript, targeted ESLint and production builds also passed. The preview emitted the known Windows symlink trace warning without blocking the build. No real backup was created, downloaded, restored or deleted; browser fixture traffic was intercepted. A concurrent deletion between the HEAD and GET requests could still fail after preflight, so this check primarily protects the normal missing/stale-list case.

The web build was deployed when the local Admin page showed no scan or player, and port 8080 returned to ready. Continue with backup upload validation and other admin error flows via isolated fixtures, while authenticated two-web-player Connect remains open.

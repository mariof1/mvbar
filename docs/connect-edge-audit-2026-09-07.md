# Connect edge-case audit: Android and web

Follow-up to the [initial Connect audit](connect-audit-2026-09-07.md).
Scope: Android ↔ web, web ↔ web, remote sliders, queue boundaries, concurrent
handoffs, reconnection, and music/podcast interaction. TV was excluded.

## Findings and fixes

- **Web remote slider:** reproduced the thumb snapping back during a drag and
  sending many seek requests. It now keeps a local draft, commits once on
  release, supports keyboard seeking, disables seeking until duration is known,
  and cancels a drag when the song/device changes. Unconfirmed drafts expire.
- **Android remote slider:** reproduced a stale-duration calculation after the
  remote song changed. A 60% drag landed at 40% of the new song. Updated callbacks
  now use the current duration; the repeat test landed at 60.4%. Track changes
  cancel an in-progress gesture. The slider now exposes an accessibility seek
  action and progress information.
- **Failed transfer selection:** both controllers now wait for acknowledgement
  before selecting the destination. Failed transfers retain the original
  selection; overlapping picker requests are blocked while one is pending.
- **Concurrent server transfers:** transfers sharing a source/destination are
  rejected while pending, preventing two simultaneous handoffs involving the
  same player.
- **Source changes during transfer:** if the source changes songs before the
  destination confirms, the stale destination is paused and the newer source
  playback is left alone. The controller receives a failure explaining why.
- **Podcast handoff attempts:** transfers are not implemented for podcasts or
  audiobooks. Both controllers now explain this without stopping local long-form
  playback. Tested the Android warning and continued playback on BlueStacks,
  and covered the browser behavior with an isolated episode fixture. Native
  stale music controls cannot seek/stop a podcast; an explicit play-music request
  can still replace it. Native queue snapshots preserve original indices and do
  not advertise a music queue while a podcast is active.
- **Android cold start:** reproduced a command failure immediately after launch,
  when discovery preceded player initialization. Incoming commands now wait up
  to ten seconds for initialization. A mutex prevents competing controller
  initializations, and commands abandoned by a socket/session change are ignored.
- **Failed Android remote send:** a failed send is consumed and reported instead
  of falling through to control the local player.
- **Taking control of an active player:** selecting an already-playing target
  from a paused source now preserves the target's playback instead of replacing
  it with the source's old paused queue. An actively playing source still
  transfers when another device is selected.
- **Paused skip and playback results:** remote Next/Previous preserve pause on
  the web receiver, matching Android. Play-index waits for browser playback and
  reports a failure if the browser blocks it.

## Evidence and test scope

Automated coverage is in:

- `api/test/connectIntegration.test.mjs` and `connectProtocol.test.mjs`:
  five tests including account isolation, command routing, transfer failure,
  disconnect/replacement, timeout, overlapping handoffs and source changes.
- `web/tests/connect-edgecases.spec.ts`, `connect-playback.spec.ts` and
  `connect-modal.spec.ts`: thirteen tests covering the controller/receiver,
  delayed snapshots, pointer/keyboard interaction, failed transfer selection,
  podcast safeguards, cancellation and responsive dialogs.
- Android phone JVM suite: 44 tests; debug APK compilation. Slider and startup
  fixes additionally exercised in BlueStacks, because JVM model tests do not
  establish media-controller/UI behavior.

Live tests used authenticated clients through `https://music2.faldasz.com`:

| Live scenario | Verification |
| --- | --- |
| Web A → web B paused handoff | Picker action; destination song, pause and saved position checked. |
| Remote web drag while paused | Actual slider pointer gesture; destination media position checked. |
| Remote keyboard seek | Home key; destination returned to start without resuming. |
| Remote play and seeking while playing | Receiver playing state and advancing media position checked. |
| Web B → web A playing handoff | Picker action; new target playing and old source paused. |
| Queue selection/boundaries | Selected index and pause behavior checked. |
| Reconnection/control recovery | Browser socket closed and re-registered with its identity; controls exercised again. |
| Android → web using Android picker | Real BlueStacks UI selection and destination state checked. |
| Android remote slider | Real drag; outgoing seek and browser media position checked. |
| Android remote song changes | Repeated drag after duration changed; stale-duration defect reproduced then retested. |
| Song change during Android drag | Changed remote song during an injected swipe; no stale seek sent to the new song. |
| Android podcast transfer attempt | Explanatory message appeared; episode remained playing. |
| Android startup command | Command issued immediately after APK update/launch; initialization fix retested. |

The local live-test scripts/results are under `.local/` and are not CI tests:
they require an authenticated server and BlueStacks and can affect listening
history. Browser fixtures use mocked media for deterministic failures; live
browser checks use real media and Chromium with autoplay explicitly allowed.

## Remaining limits

**Podcast/audiobook transfer is still unsupported.** These checks establish safe
handling of attempted handoffs, not successful long-form transfer. Implementing
that requires a media-type-aware protocol and receivers for episode/chapter
identity, position and progress ownership.

The existing 500-song transfer window and 4 MiB message bound remain. Physical
Android background/lock-screen behavior, Bluetooth/audio-focus changes and
unusual network conditions are not exhaustively covered by BlueStacks. No claim
is made that every possible edge case or combination has been tested.

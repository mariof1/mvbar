# MVBar Connect audit — 7 September 2026

Scope: web controller/player, server WebSocket routing, Android phone and TV
implementations, and Wear integration. This combines isolated protocol/browser
tests, native builds and real Android playback in BlueStacks through
https://music2.faldasz.com. No library media was modified. Live playback tests
used three library songs and can appear in listening history. The existing
Android login was preserved while upgrading its debug APK in place.

## Confirmed defects fixed

1. **Large queues selected the wrong song.** The server previously retained the
   first 500 songs and clamped the selected index. It now retains a window around
   the selected occurrence and maps queue commands back to the player's native
   indices. Phone and TV no longer truncate before sending the selected song.
   Duplicate songs retain their selected occurrence rather than matching the
   first song with that ID.
2. **Invalid queue indices could affect a different song.** Negative, missing,
   fractional and out-of-range indices are rejected instead of being clamped to
   the first/last entry. Fractional track IDs are rejected too.
3. **Oversized queue additions silently lost songs.** Add/Play-next requests over
   500 songs now return an explicit error instead of silently dropping the rest.
4. **Clear upcoming stopped Android and TV playback.** That command now removes
   the other queue entries and retains the current song. Stop remains separate.
5. **TV queue selection did not resume paused playback.** Play-index now seeks
   and starts playback.
6. **Paused browser transfers called Play.** They now load the source without
   starting it; playing transfers await the original playback promise instead of
   calling Play twice. Blocked playback returns a failed execution result.
7. **Closing a controller could leave both players running after transfer.**
   Pending transfers now survive controller disconnection until the target
   confirms or fails. Source pause still follows successful target confirmation.
8. **Replacing a device left old commands pending.** Re-registration invalidates
   commands for the replaced socket, rather than waiting for their timeout.
9. **Duplicated browser tabs could steal each other's player identity.** A live
   tab receiving a replacement event now obtains a distinct identity and
   re-registers. Its subsequent reconnect retains that identity.
10. **Disconnected sends could disappear silently; queue notices implied execution
    before confirmation.** Browser sends now report disconnection, and initial
    queue notices say the request was sent rather than claiming it was applied.
11. **Paused seeks could transfer an old position.** Reproduced in BlueStacks.
    Android now updates position on player discontinuities and final pause;
    phone/TV publishers send paused position changes immediately. The browser
    also publishes completed seeks immediately instead of throttling them away.
12. **Stopping could leave an old saved queue for the next launch.** Explicitly
    clearing the Android queue now also clears its saved resume state.

## Verification

| Area | Evidence |
| --- | --- |
| Discovery and privacy | Isolated WebSocket clients verify per-account device lists and rejection of commands targeting another account. Anonymous sockets close with code 4001. |
| Protocol commands | Play, pause, toggle, next, previous, seek, stop, play-tracks, add-tracks, play-next, play-index, remove-index, reorder and clear-queue routing exercised. |
| Transfers | Queue, selected song and position preserved; failed target does not pause source; successful target does; controller disconnect tested. |
| Failure handling | Capability rejection, legacy acknowledgement, invalid indices, oversized additions, target disconnect/replacement, forged result and 12-second timeout exercised. |
| Browser receiver | Paused transfer makes zero Play calls; playing transfer makes one; blocked playback and invalid commands fail; clear/stop behavior checked. Media methods are instrumented, not real decoding. |
| Browser controller | Picker selection, playback buttons, seek, queue play/remove/clear and disappearing target exercised without starting local playback. |
| Lifecycle | Duplicate identity recovery, reconnection with stable identity, device rename and saved label exercised. |
| Responsive UI | Connect modal/popover at 390, 820 and 1280 pixels; mobile focus containment, Escape, backdrop, close and body-scroll restoration. |
| Native builds | 67 phone/TV/Wear JVM tests passed; all three debug APKs built. |
| BlueStacks through HTTPS proxy | Actual playback progress, paused queue loading, seek, pause, next/previous, queue play/add/play-next, reorder/remove, clear-upcoming while playing, Android-to-browser and browser-to-Android playing transfers, paused position transfer, app restart and rediscovery. |

Reproducible tests:

```text
npm --prefix api run build
node --test api/test/connectProtocol.test.mjs api/test/connectIntegration.test.mjs
# From web/, with the current production build running on localhost:8080:
node node_modules/@playwright/test/cli.js test tests/connect-playback.spec.ts tests/connect-modal.spec.ts --workers=1
# From mvbar-android/ after loading dev-env.ps1:
./gradlew.bat :app:testDebugUnitTest :tv:testDebugUnitTest :app:assembleDebug :tv:assembleDebug :wear:assembleDebug
```

## Product limits and outstanding device validation

- Discovery is account-based through the server; there is no separate pairing
  code or LAN broadcast discovery step.
- Connect carries music. Podcast/audiobook transfers are not implemented.
- Queue snapshots and transfers contain up to 500 songs around the active song;
  transferring a longer queue does not transfer its entire contents. Add/Play
  next supports up to 500 songs per command. WebSocket messages remain bounded
  at 4 MiB, so exceptionally large client queues can exceed the transport limit.
- Deploy the updated server and phone/TV builds together to obtain the complete
  large-queue fix; older native builds still truncate before transmission.
- Wear currently uses its phone data/message link and does not register as an
  independent Connect target. Its APK compiling does not establish standalone
  Connect support.
- Browser/Android audio progress and bidirectional transfers were observed in
  the live emulator test. Headless Chromium explicitly allowed autoplay; a new
  browser with its default autoplay restrictions can still require a first tap.
- Physical Android background/lock-screen behavior, TV remote interaction,
  phone-to-watch operation and Chromecast behavior still need device validation. Native command
  acknowledgement means the player accepted the operation, not proof that audio
  reached the speaker. Legacy clients cannot confirm execution at all.

These limits should not be read as an all-devices/all-networks guarantee.

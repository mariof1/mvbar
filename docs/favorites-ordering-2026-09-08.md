# Favorites ordering

Favorites now have a saved, per-user order shared by the web and Android apps.

- Web: hold a grip for 300 ms and drag; arrow keys on a focused grip move a song one place. Touch scrolling remains available on the rest of the row. Escape/pointer cancellation restores the draft.
- Android: hold a row or its grip and drag. Accessibility actions offer Move up/Move down. The offline cache retains the order; changing it requires a server connection.
- New favorites appear first. Moving existing favorites does not change their added date, remove unseen items, or affect the playback queue.
- `POST /api/favorites/reorder` accepts numeric `trackId` and required `beforeTrackId` (null means the end). Anchors avoid replacing an entire paginated list. The server validates access/membership and serializes each user's mutations in a transaction.
- `favorite:reordered` refreshes connected clients. Existing installations gain a nullable position column automatically. Android includes Room migration 5 to 6 and retrieves all favorites pages.

Validation: API integration tests against an isolated PostgreSQL instance cover 205 favorites, pagination, concurrent moves, add/remove, user isolation, library access, and invalid requests. Eight production browser tests pass (four reorder tests and four mobile dialog regressions), covering mouse/touch, cancellation, failure rollback, refresh persistence, and pagination boundaries. API/web builds and targeted lint pass. Android debug build, unit tests, and lint pass; the new unit tests cover multi-page loading and null-anchor serialization.

Live verification on the local server and Android emulator confirmed exact-position Android-to-web and web-to-Android moves, including websocket refresh and persistence. Android's migrated cache contains the same saved order. Test moves were restored to the original seven-song order; playback was not started. The updated web/API run on port 8080 and the debug APK is installed on the emulator.

Follow-up: the entire dragged row now has a cyan background and outline, and Play all loads every favorites page before starting the saved order. Five production favorites tests pass, including a 205-track Play all queue and highlight lifecycle checks. The production web build passes.

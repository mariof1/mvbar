# MVBar Connect

MVBar Connect lets the web app, PWA, Android phone app, and Android TV app discover and control the other active players signed in to the same MVBar account.

## What it supports

- Live player discovery and presence
- Play, pause, resume, stop, previous, next, and seek
- Start a song, album, playlist, search result, or recommendation mix on another player
- Add one or more songs to another player's queue
- Insert one or more songs directly after the currently playing song
- Select, remove, reorder, or clear queue entries
- Transfer the current music queue, position, and play/pause state between players

Podcasts and audiobooks remain local to their player. MVBar Connect currently transfers music tracks whose IDs belong to the connected MVBar server.

## Architecture and security

Connect uses the existing authenticated `/api/ws` WebSocket. It does not open another port, require a cloud relay, or add a secret or environment variable. The API keeps device presence and current playback state in memory and removes a player when its socket disconnects. Device snapshots include the authenticated user's remote queues so controller queue indexes always refer to the real target queue.

Every discovery, command, and transfer lookup is scoped to the authenticated user ID on the server. Clients cannot name another account or address one of its devices. Commands are allowlisted and their indexes, positions, track IDs, text fields, and queue size are validated before forwarding. WebSocket sessions are closed when their login is invalidated, inactive peers are terminated after a missed heartbeat, and inbound messages are capped at 4 MiB.

Command acknowledgements are end-to-end for players advertising `command-results-v1`: the target reports whether it executed the command, and the controller only receives success after that report. Playback transfer is two-phase—the destination must accept the transferred queue before the source is paused—so an unavailable or autoplay-blocked destination does not interrupt the source. Older installed players remain controllable with optimistic acknowledgements until they are upgraded; `play-next` is capability-gated because older players do not understand it.

Because presence is currently process-local, a deployment that runs multiple API replicas would need WebSocket affinity or a Redis-backed Connect registry. The standard single-API Docker and standalone deployments need no additional configuration.

## Using it

Open the device button in the web or Android app, or choose **Connect** in the Android TV top bar. Pick a signed-in player. If the current player has music loaded, MVBar transfers its queue and position; otherwise MVBar simply changes which player new selections and playback controls target.

Browser players may require one initial interaction with the page before the browser permits remotely initiated audio playback. This is imposed by browser autoplay policy; later playback controls continue normally while the app remains active.

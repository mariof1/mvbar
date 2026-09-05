# Missing Music

Missing Music is a removable first-party MVBar plugin. It compares local artists, albums, and tracks with MusicBrainz, then keeps the gaps in a server-side wanted list. An optional external provider can receive approved request metadata automatically.

It does not download, store, import, or stream media. If an administrator or external provider later puts authorized media into an existing MVBar library, MVBar's normal library scanner discovers it independently.

## Quick start

1. Open **Admin → Plugins**.
2. Find **Missing Music** under **Included with MVBar** and select **Install with one click**.
3. Review the read-only catalog/request permissions and select **Review & enable**.
4. Open **Missing Music** from the main navigation.
5. Pick a local artist. Artists with MusicBrainz tags open immediately; for an untagged artist, choose the correct MusicBrainz match. MVBar remembers that choice.

No files, command-line steps, API keys, or external services are required for this wanted-list mode. Users can request missing albums or individual tracks. Administrators can approve, reject, retry, delete, or manually mark requests fulfilled.

By default, the comparison includes albums and EPs while hiding common live, compilation, remix, DJ-mix, interview, and spoken variants. Both lists are editable in the plugin configuration.

## Optional automatic provider

Set **Request provider URL** only when you already have a compatible service that should receive approved requests. Add its bearer token if required. Enable **Allow a private-network provider** for a trusted HTTP(S) service on your LAN, such as `http://192.168.1.20:8080`.

Leave the provider URL blank to keep using the built-in wanted list. Approved requests remain available for manual handling and can be marked fulfilled by an administrator.

## Request-provider contract

MVBar sends `POST <base-url>/v1/requests` with an optional bearer token and this JSON shape:

```json
{
  "requestId": "MVBar request UUID",
  "itemType": "album",
  "artist": "Artist name",
  "title": "Release or track title",
  "album": "Album title",
  "musicBrainz": {
    "artistId": "artist MBID",
    "releaseGroupId": "release-group MBID",
    "releaseId": "release MBID or null",
    "recordingId": "recording MBID or null"
  }
}
```

The service returns:

```json
{
  "providerRequestId": "provider-owned stable ID",
  "status": "queued"
}
```

MVBar polls `GET <base-url>/v1/requests/<providerRequestId>`. Accepted status values are:

- queued: `queued`, `processing`, `submitted`
- complete: `ready`, `complete`, `completed`, `fulfilled`
- failed: `failed`, `error`, `rejected`

A failure response can include an `error` string. No media URL or file is accepted by this contract.

Public providers must use HTTPS. Private or loopback providers require the administrator to enable the explicit private-network option. Redirects are rejected, and the token is sent only to the configured origin.

## Lifecycle

The one-click package is included in every Docker and standalone build. Advanced users can still build and upload `plugins/missing-music/dist/mvbar-missing-music.ndp` manually.

Disabling the plugin hides the feature and stops provider handoffs. Removing it deletes its request records, saved artist matches, and MusicBrainz cache through the normal plugin cascade. It never removes library media.

Plugin state is held in the MVBar database. The `.ndp` package itself is held in the persistent plugin directory:

- Docker: `/data/plugins`
- Linux standalone: `~/.local/share/mvbar/data/plugins`
- Windows standalone: `%LOCALAPPDATA%\MVBar\data\plugins`

## Troubleshooting

- **An artist asks for a match:** its local files do not contain a MusicBrainz artist ID. Choose the closest MusicBrainz result; use **Change match** later if needed.
- **Too many unusual releases:** adjust **Release types** or **Exclude release variants** in Admin → Plugins.
- **A request stays “On wanted list”:** this is expected without a provider. Handle it manually and select **Mark fulfilled**.
- **The navigation item is missing:** ensure the package is installed, globally enabled by `PLUGINS_ENABLED=true`, and enabled on its Admin → Plugins card.
- **MusicBrainz is temporarily unavailable:** wait briefly and retry. MVBar rate-limits calls and caches successful catalog responses for 24 hours.

# Missing Music

Missing Music is a removable first-party MVBar plugin. It compares MusicBrainz release groups and recordings with MusicBrainz tags in the enabled local libraries, lets users request gaps, and hands approved request metadata to an external service.

It does not download, store, import, or stream media. Delivery is owned entirely by the external service. If that service later puts authorized media into an existing MVBar library, MVBar's normal library scanner discovers it independently.

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

Upload the generated `.ndp` in Admin → Plugins, review its permissions, configure it, and enable it. Disabling it hides the feature and stops handoffs. Removing it deletes its request records and MusicBrainz cache through the normal plugin cascade.

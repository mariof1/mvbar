# MVBar plugins

MVBar plugins are ZIP-based `.ndp` packages containing `manifest.json` and
`plugin.wasm` at the archive root. The format is compatible with Navidrome's
WebAssembly plugin packaging, so packages such as AudioMuse-AI can be installed
without modifying MVBar.

## Install and remove

Administrators can open **Admin → Plugins** and drop an `.ndp` package into the
upload area. Every new or changed package starts disabled. Review its requested
permissions and select **Review & enable**. Updating the package disables it
again so new code cannot run without another administrator approval.

First-party packages included with MVBar appear separately with an
**Install with one click** action. They follow the same permission review and
disabled-by-default rules; no server file copy is required.

Packages can also be copied directly into `PLUGINS_DIR` and loaded with
**Rescan folder**. Defaults are:

- Docker: `/data/plugins` (the persistent `plugins` volume)
- Linux standalone: `~/.local/share/mvbar/data/plugins`
- Windows standalone: `%LOCALAPPDATA%\MVBar\data\plugins`

Disabling a plugin immediately removes it from capability selection. Removing
it deletes the package, configuration, run history, KV state, and isolated
filesystem data. It does not change users, the core schema, or source media.
With no enabled plugins MVBar follows its built-in vanilla behavior.

## AudioMuse-AI

Install the `audiomuseai.ndp` package from the AudioMuse-AI Navidrome plugin
project. Save its API URL, optional bearer token, and server name in the plugin
configuration, then enable it. MVBar uses its
`nd_get_similar_songs_by_track` export for the OpenSubsonic
`getSimilarSongs`, `getSimilarSongs2`, and `getSimilarSongsID3` endpoints.
Clients such as Symfonium can therefore use AudioMuse recommendations through
their normal Instant Mix flow.

The current AudioMuse manifest requests `requiredHosts: ["*"]`. MVBar displays
this as broad network access before enablement. A more restrictive custom build
can list the AudioMuse host explicitly.

## Runtime isolation

Each call runs in a fresh worker-thread WebAssembly instance. MVBar applies a
hard timeout, memory ceiling, concurrency limit, response-size limit, and
redirect validation. Plugins cannot import Node.js modules or execute
JavaScript in MVBar's main API thread.

MVBar currently grants these manifest permissions:

| Permission | Access |
| --- | --- |
| `config` | Read the plugin's server-side configuration. |
| `http` | Send HTTP(S) requests. `requiredHosts` is enforced on every request and redirect. Private hosts require an explicit allowlist entry. |
| `kvstore` | Plugin-namespaced persistent byte storage, with `maxSize` support. |
| `storage` | Read/write access to the plugin's isolated `/plugin-data` directory. |

Unknown permissions are shown as unsupported and are never granted. Plugins do
not receive direct database, account, music-library, shell, or unrestricted
filesystem access.

Runtime settings:

```dotenv
PLUGINS_ENABLED=true
PLUGINS_DIR=/data/plugins
PLUGIN_MAX_UPLOAD_MB=50
PLUGIN_TIMEOUT_MS=15000
PLUGIN_MEMORY_MB=64
PLUGIN_MAX_CONCURRENCY=4
```

Set `PLUGINS_ENABLED=false` for a global kill switch. Packages and
configuration remain installed, but no plugin code executes.

## Develop a plugin

Use an Extism PDK (Go/TinyGo, Rust, JavaScript, Python, or another supported
language) and export functions with the Extism bytes-in/bytes-out convention.
Navidrome PDK plugins can use the compatible `config`, `http`, and `kvstore`
host services listed above.

A minimal package manifest is:

```json
{
  "id": "example.tools",
  "name": "Example Tools",
  "author": "Example Author",
  "version": "1.0.0",
  "description": "An isolated MVBar extension",
  "permissions": {
    "config": { "reason": "Read the configured service URL" },
    "http": {
      "reason": "Call the example service",
      "requiredHosts": ["api.example.com"]
    },
    "kvstore": {
      "reason": "Remember action state",
      "maxSize": "1 MiB"
    }
  },
  "config": {
    "schema": {
      "type": "object",
      "properties": {
        "apiToken": {
          "type": "string",
          "title": "API token",
          "format": "password"
        }
      }
    }
  }
}
```

### MVBar admin actions

Custom packages may declare explicit administrator-triggered actions. The
export receives the form input as JSON and returns JSON. For example:

```json
{
  "mvbar": {
    "actions": [
      {
        "id": "download",
        "name": "Download music",
        "description": "Ask the configured service to prepare a download",
        "export": "mvbar_download",
        "inputSchema": {
          "type": "object",
          "required": ["url"],
          "properties": {
            "url": {
              "type": "string",
              "title": "Source URL"
            }
          }
        }
      }
    ]
  }
}
```

Actions appear in the plugin's admin card and can run only through an
authenticated administrator request. A downloader can write into its isolated
storage or call a declared remote service; MVBar deliberately does not grant it
write access to source music folders. Importing completed media remains an
explicit server/library operation.

Create the package with both required files at the root:

```text
example-tools.ndp
├── manifest.json
└── plugin.wasm
```

## First-party Missing Music request plugin

The repository includes `plugins/missing-music`, a removable request-only
extension. Install it directly from **Admin → Plugins → Included with MVBar**.
It compares MusicBrainz album and recording identifiers with the enabled MVBar
libraries, presents missing albums or tracks to users, and stores an approval
queue in plugin-owned database rows. Local artists without MusicBrainz tags are
included and can be matched once through MusicBrainz; the saved match is reused.

The plugin works without external configuration as a managed wanted list.
Administrators can approve, reject, and manually mark requests fulfilled.
Optionally, approved requests can be handed to an administrator-configured
external HTTP service. MVBar sends metadata and MusicBrainz identifiers only.
The extension has no download, media storage, import, or streaming path;
delivery stays outside the plugin. Removing the package cascades its request
rows, saved artist matches, and MusicBrainz cache.

Build the installable package with:

```bash
cd api
npm run build:missing-music-plugin
```

The output is `plugins/missing-music/dist/mvbar-missing-music.ndp` and is also
copied into the API's bundled-plugin assets for production packaging. See
`plugins/missing-music/README.md` for setup, troubleshooting, and the optional
provider API contract.

## Backups

Database backups retain plugin manifests, configuration, enablement approval,
KV data, and run records. `.ndp` binaries and files under isolated
`/plugin-data` storage are not embedded in a database-only backup. Install the
same package on the destination and rescan it; if the package is absent MVBar
disables it and continues in vanilla mode.

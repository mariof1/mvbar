# MVBar Standalone for Windows

This experimental build packages MVBar and its required services into one
Windows x64 executable. The destination computer does not need Docker, Node.js,
PostgreSQL, Redis, Meilisearch, FFmpeg, or an installer.

## Build

Run from PowerShell on the build computer:

```powershell
.\windows\standalone\build-standalone.ps1
```

Use `-SkipAppBuild` to reuse existing successful API, worker, and web builds.
The executable and SHA-256 checksum are written to `windows\standalone\out`.

The build computer must have npm dependencies installed and the local native
runtime cache prepared under the workspace `.native-runtime` directory.

## Run

Double-click the generated EXE. On first run it:

1. Extracts its versioned application payload under `%LOCALAPPDATA%\MVBar\app`.
2. Initializes PostgreSQL and the other local services.
3. Creates an administrator and writes the credentials to
   `%LOCALAPPDATA%\MVBar\credentials.txt`.
4. Opens MVBar in the default browser.

The launcher shows startup progress without opening a PowerShell window. Once
MVBar is ready, the same window provides selectable administrator credentials
and copy buttons. Closing the window keeps MVBar running in the Windows
notification area; use the tray menu to reopen MVBar, view credentials or logs,
or stop the local server.

Application data survives upgrades under `%LOCALAPPDATA%\MVBar\data`. Settings
are stored in `%LOCALAPPDATA%\MVBar\config.env`.

The defaults use the current user's `Music` folder and
`%USERPROFILE%\Audiobooks`. Edit `MUSIC_DIRS` and `AUDIOBOOK_DIRS` in
`config.env` to use other local or UNC paths. Multiple paths are comma
separated.

The service listens on `127.0.0.1` by default. Set `LISTEN_HOST=0.0.0.0` to
make it available to other devices; Windows may then request firewall
permission.

Set `MVBAR_HOME` before launching to use a different data location. This is
useful for isolated testing.

## Limitations

- The executable is not Authenticode-signed, so Microsoft SmartScreen may warn
  on a newly downloaded build.
- Google OAuth requires callback URLs configured for the local address. Local
  password authentication works without external configuration.
- This package currently targets 64-bit Windows 10 and Windows 11.

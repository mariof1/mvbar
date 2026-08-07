# MVBar Standalone for Linux

This build packages MVBar, Node.js, PostgreSQL, Redis, Meilisearch, FFmpeg, and
their required libraries into one Linux x86-64 executable. Docker and a Node.js
installation are not required on the destination computer.

The current build target is Debian 12 x86-64. The destination needs only the
standard GNU C library, `/bin/sh`, `tar`, and `gzip` from the base operating
system.

## Build

Build on Debian 12 with:

```bash
sudo apt-get update
sudo apt-get install -y build-essential file git gzip postgresql-15 redis-server ffmpeg python3 tar
./linux/standalone/build-standalone.sh --meilisearch /path/to/meilisearch
```

Node.js 22 is recommended. Pass its executable with `--node PATH` if `node` is
not already on `PATH`. The executable and SHA-256 checksum are written to
`linux/standalone/out`.

Use `--skip-app-build` to reuse existing successful API, worker, and web builds.

## Run

Make the file executable and start MVBar:

```bash
chmod +x MVBar-Standalone-*-linux-x64
./MVBar-Standalone-*-linux-x64 start
```

On first run the binary:

1. Extracts its versioned application payload under
   `~/.local/share/mvbar/app`.
2. Initializes PostgreSQL and the other local services.
3. Creates an administrator and writes the credentials to
   `~/.local/share/mvbar/credentials.txt`.
4. Starts MVBar in the background and prints its URL.

Application data survives binary upgrades under `~/.local/share/mvbar/data`.
Set `MVBAR_HOME` before running the binary to use a different data location.

Useful commands:

```bash
./MVBar-Standalone-*-linux-x64 status
./MVBar-Standalone-*-linux-x64 credentials
./MVBar-Standalone-*-linux-x64 config-path
./MVBar-Standalone-*-linux-x64 logs api
./MVBar-Standalone-*-linux-x64 restart
./MVBar-Standalone-*-linux-x64 stop
```

The default music library is `~/Music`, the default listening address is
`127.0.0.1`, and the default public port is `8080`. Edit `config.env` and
restart to use other music/audiobook folders or to set `LISTEN_HOST=0.0.0.0`
for LAN access. Library paths are comma separated.

## systemd

For a dedicated server, copy the binary and the included template unit to
stable locations. The instance name is the Linux account that owns MVBar:

```bash
sudo install -m 0755 MVBar-Standalone-*-linux-x64 /usr/local/bin/mvbar
sudo install -m 0644 linux/standalone/mvbar@.service /etc/systemd/system/mvbar@.service
sudo systemctl daemon-reload
sudo systemctl enable --now mvbar@lanadmin.service
```

## Limitations

- The executable is not code-signed.
- The bundled native runtimes currently target Debian 12 x86-64 and compatible
  glibc environments.
- Google OAuth requires callback URLs configured for the local address. Local
  password authentication works without external configuration.

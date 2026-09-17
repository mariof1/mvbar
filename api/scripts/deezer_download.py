"""Optional streamrip bridge for an administrator-approved Missing Music request.

Reads one JSON job on stdin and emits JSON lines for progress and the final
result. The Deezer session cookie remains in the environment.
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


MAX_ARTWORK_BYTES = 8 * 1024 * 1024


class ArtworkError(Exception):
    pass


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def download_artwork(url):
    parts = urlsplit(url)
    if (parts.scheme != "https" or parts.hostname != "cdn-images.dzcdn.net"
            or parts.username or parts.password or parts.port not in (None, 443)
            or not parts.path.startswith("/images/cover/") or parts.fragment):
        raise ArtworkError("Invalid Deezer artwork URL")
    try:
        request = Request(url, headers={"Accept": "image/jpeg, image/png"})
        with build_opener(NoRedirects).open(request, timeout=12) as response:
            data = response.read(MAX_ARTWORK_BYTES + 1)
    except Exception as error:
        raise ArtworkError("Deezer artwork could not be downloaded") from error
    if len(data) < 100 or len(data) > MAX_ARTWORK_BYTES:
        raise ArtworkError("Deezer artwork is empty or too large")
    if data.startswith(b"\xff\xd8\xff"):
        return data, "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return data, "image/png"
    raise ArtworkError("Deezer artwork is not a supported image")


def embed_artwork(output, extension, artwork):
    if not artwork:
        return
    data, mime = artwork
    if extension == "mp3":
        from mutagen.id3 import APIC, ID3

        tags = ID3(output)
        tags.delall("APIC")
        tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=data))
        tags.save(output)
    elif extension == "flac":
        from mutagen.flac import FLAC, Picture

        audio = FLAC(output)
        picture = Picture()
        picture.type = 3
        picture.mime = mime
        picture.desc = "Cover"
        picture.data = data
        audio.clear_pictures()
        audio.add_picture(picture)
        audio.save()


async def main():
    from mutagen import File
    from streamrip.client.deezer import DeezerClient
    from streamrip.config import Config

    job = json.load(sys.stdin)
    tracks = job.get("tracks")
    if tracks is None:
        tracks = [job["track"]]
    if not isinstance(tracks, list) or not 1 <= len(tracks) <= 200:
        raise ValueError("Invalid Deezer track list")
    if any(not str(track.get("id", "")).isdecimal() for track in tracks):
        raise ValueError("Invalid Deezer track id")
    quality = int(job["quality"])
    if quality not in (0, 1, 2):
        raise ValueError("Invalid Deezer quality")
    directory = Path(job["directory"])
    if not directory.is_dir():
        raise ValueError("Staging directory is missing")
    cover_url = job.get("coverUrl")
    artwork = await asyncio.to_thread(download_artwork, cover_url) if cover_url else None
    config = Config.defaults()
    config.session.deezer.arl = os.environ["DEEZER_ARL"]
    client = DeezerClient(config)
    extensions = []
    try:
        await client.login()
        for index, metadata in enumerate(tracks, start=1):
            track_id = str(metadata["id"])
            downloadable = await client.get_downloadable(track_id, quality=quality)
            extension = downloadable.extension.lower()
            if extension not in ("mp3", "flac"):
                raise ValueError("Unsupported Deezer audio format")
            output = directory / (f"track-{index:03d}.{extension}" if "tracks" in job else f"track.{extension}")
            await downloadable.download(str(output), lambda _bytes: None)
            audio = File(output, easy=True)
            if audio is None:
                raise ValueError("Downloaded audio could not be read")
            for key, value in (
                ("title", metadata.get("title")),
                ("artist", metadata.get("artist")),
                ("album", metadata.get("album")),
                ("albumartist", job.get("albumArtist")),
                ("isrc", metadata.get("isrc")),
                ("tracknumber", metadata.get("trackNumber")),
                ("discnumber", metadata.get("discNumber")),
                ("date", job.get("releaseDate")),
                ("genre", job.get("genre")),
            ):
                if value:
                    audio[key] = [str(item) for item in value] if isinstance(value, list) else [str(value)]
            audio.save()
            embed_artwork(output, extension, artwork)
            extensions.append(extension)
            if "tracks" in job:
                print(json.dumps({"progress": {"completed": index, "total": len(tracks)}}), flush=True)
    finally:
        session = getattr(client, "session", None)
        if session is not None:
            await session.close()

    print(json.dumps({"extensions": extensions} if "tracks" in job else {"extension": extensions[0]}))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        # Do not include tracebacks or session credentials in API responses.
        print(str(error) if isinstance(error, ArtworkError) else f"Deezer download failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)

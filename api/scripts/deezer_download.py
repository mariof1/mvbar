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


def clean_values(value):
    if value is None:
        return []
    values = value if isinstance(value, list) else [value]
    result = []
    seen = set()
    for item in values:
        if isinstance(item, dict):
            item = item.get("name")
        text = str(item or "").strip()
        if not text:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(text)
    return result


def gain_tag(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not (-100 <= number <= 100):
        return None
    return f"{number:+.2f} dB"


async def deezer_gateway_credits(client, track_id):
    try:
        detail = await asyncio.to_thread(client.client.gw.get_track, track_id)
    except Exception:
        return {"composers": [], "lyricists": []}
    contributors = detail.get("SNG_CONTRIBUTORS") if isinstance(detail, dict) else None
    if not isinstance(contributors, dict):
        return {"composers": [], "lyricists": []}
    composers = clean_values(contributors.get("composer"))
    lyricists = clean_values(
        contributors.get("author")
        or contributors.get("lyricist")
        or contributors.get("writer")
    )
    return {"composers": composers, "lyricists": lyricists}


def apply_rich_metadata(output, extension, metadata, job, credits):
    artists = clean_values(metadata.get("artists") or metadata.get("artist"))
    composers = clean_values(credits.get("composers"))
    lyricists = clean_values(credits.get("lyricists"))
    publisher = str(job.get("publisher") or "").strip()
    barcode = str(job.get("barcode") or "").strip()
    release_type = str(job.get("recordType") or "").strip()
    album_id = str(job.get("albumId") or metadata.get("albumId") or "").strip()
    track_id = str(metadata.get("id") or "").strip()
    lyrics_value = metadata.get("lyrics")
    lyrics_text = ""
    if isinstance(lyrics_value, dict):
        lyrics_text = str(lyrics_value.get("text") or "").strip()
    bpm = metadata.get("bpm")
    try:
        bpm_text = str(int(round(float(bpm)))) if bpm and float(bpm) > 0 else ""
    except (TypeError, ValueError):
        bpm_text = ""
    track_gain = gain_tag(metadata.get("gainDb"))
    album_gain = gain_tag(job.get("albumGainDb"))

    if extension == "mp3":
        from mutagen.id3 import ID3, TPE1, TBPM, TCOM, TEXT, TPUB, USLT, TXXX

        tags = ID3(output)
        if artists:
            tags.delall("TPE1")
            tags.add(TPE1(encoding=3, text=artists))
        if bpm_text:
            tags.delall("TBPM")
            tags.add(TBPM(encoding=3, text=[bpm_text]))
        if composers:
            tags.delall("TCOM")
            tags.add(TCOM(encoding=3, text=composers))
        if lyricists:
            tags.delall("TEXT")
            tags.add(TEXT(encoding=3, text=lyricists))
        if publisher:
            tags.delall("TPUB")
            tags.add(TPUB(encoding=3, text=[publisher]))
        if lyrics_text:
            tags.delall("USLT")
            tags.add(USLT(encoding=3, lang="eng", desc="", text=lyrics_text))

        custom = {
            "BARCODE": barcode,
            "RELEASETYPE": release_type,
            "REPLAYGAIN_TRACK_GAIN": track_gain,
            "REPLAYGAIN_ALBUM_GAIN": album_gain,
            "DEEZER_TRACK_ID": track_id,
            "DEEZER_ALBUM_ID": album_id,
        }
        for description, value in custom.items():
            if not value:
                continue
            for key in list(tags.keys()):
                frame = tags.get(key)
                if isinstance(frame, TXXX) and frame.desc.casefold() == description.casefold():
                    del tags[key]
            tags.add(TXXX(encoding=3, desc=description, text=[value]))
        tags.save(output, v2_version=4)

    elif extension == "flac":
        from mutagen.flac import FLAC

        audio = FLAC(output)
        if artists:
            audio["ARTIST"] = artists
        if bpm_text:
            audio["BPM"] = [bpm_text]
        if composers:
            audio["COMPOSER"] = composers
        if lyricists:
            audio["LYRICIST"] = lyricists
        if publisher:
            audio["PUBLISHER"] = [publisher]
        if lyrics_text:
            audio["LYRICS"] = [lyrics_text]
        if barcode:
            audio["BARCODE"] = [barcode]
        if release_type:
            audio["RELEASETYPE"] = [release_type]
        if track_gain:
            audio["REPLAYGAIN_TRACK_GAIN"] = [track_gain]
        if album_gain:
            audio["REPLAYGAIN_ALBUM_GAIN"] = [album_gain]
        if track_id:
            audio["DEEZER_TRACK_ID"] = [track_id]
        if album_id:
            audio["DEEZER_ALBUM_ID"] = [album_id]
        audio.save()


async def get_downloadable_with_fallback(client, track_id, quality):
    last_error = None
    for candidate_quality in range(quality, -1, -1):
        try:
            return await client.get_downloadable(track_id, quality=candidate_quality)
        except Exception as error:
            if type(error).__name__ != "NonStreamableError":
                raise
            last_error = error
    if last_error is not None:
        raise last_error
    raise RuntimeError("No Deezer quality candidates were available")


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
    artwork = None
    if cover_url:
        try:
            artwork = await asyncio.to_thread(download_artwork, cover_url)
        except ArtworkError as error:
            # Cover art is optional. Audio should still download if the Deezer
            # CDN is unavailable or returns an unsupported image.
            print(f"Artwork warning: {error}", file=sys.stderr, flush=True)
    config = Config.defaults()
    config.session.deezer.arl = os.environ["DEEZER_ARL"]
    client = DeezerClient(config)
    extensions = []
    try:
        await client.login()
        for index, metadata in enumerate(tracks, start=1):
            track_id = str(metadata["id"])
            downloadable = await get_downloadable_with_fallback(client, track_id, quality)
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
                ("artist", metadata.get("artists") or metadata.get("artist")),
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
            credits = await deezer_gateway_credits(client, track_id)
            try:
                apply_rich_metadata(output, extension, metadata, job, credits)
            except Exception:
                # Rich tags are best effort; a successfully downloaded audio file remains usable.
                print("Metadata warning: rich tags could not be applied", file=sys.stderr, flush=True)
            try:
                embed_artwork(output, extension, artwork)
            except Exception:
                # Embedded artwork is best-effort and must never invalidate a
                # successfully downloaded audio file.
                print("Artwork warning: cover could not be embedded", file=sys.stderr, flush=True)
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
        error_name = type(error).__name__
        if error_name == "NonStreamableError":
            print("DEEZER_UNAVAILABLE: track is not streamable for this Deezer account or region", file=sys.stderr)
        elif isinstance(error, ArtworkError):
            print(str(error), file=sys.stderr)
        else:
            print(f"Deezer download failed: {error_name}", file=sys.stderr)
        sys.exit(1)

"""Safely edit audio metadata with Mutagen.

The editor changes only fields supplied in the JSON payload, preserves artwork
and unrelated tags, writes to a same-directory temporary copy, then atomically
replaces the original file after a successful save.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from mutagen.flac import FLAC
from mutagen.id3 import (
    COMM,
    ID3,
    ID3NoHeaderError,
    TALB,
    TBPM,
    TCOM,
    TCOP,
    TCON,
    TDRC,
    TDOR,
    TIT1,
    TIT2,
    TKEY,
    TLAN,
    TMOO,
    TPE1,
    TPE2,
    TPE3,
    TPOS,
    TPUB,
    TRCK,
    TSOP,
    TSO2,
    TSOA,
    TSOT,
    TSRC,
    TXXX,
)
from mutagen.mp4 import MP4
from mutagen.oggopus import OggOpus
from mutagen.oggvorbis import OggVorbis
from mutagen.wave import WAVE


SUPPORTED = {".mp3", ".flac", ".m4a", ".mp4", ".ogg", ".opus", ".wav"}

LANGUAGE_CODES = {
    "english": "eng", "eng": "eng", "en": "eng",
    "polish": "pol", "pol": "pol", "pl": "pol",
    "german": "deu", "de": "deu", "deu": "deu", "ger": "deu",
    "spanish": "spa", "es": "spa", "spa": "spa",
    "french": "fra", "fr": "fra", "fra": "fra", "fre": "fra",
    "italian": "ita", "it": "ita", "ita": "ita",
    "portuguese": "por", "pt": "por", "por": "por",
    "romanian": "ron", "ro": "ron", "ron": "ron", "rum": "ron",
    "russian": "rus", "ru": "rus", "rus": "rus",
    "ukrainian": "ukr", "uk": "ukr", "ukr": "ukr",
    "lithuanian": "lit", "lt": "lit", "lit": "lit",
    "dutch": "nld", "nl": "nld", "nld": "nld", "dut": "nld",
    "swedish": "swe", "sv": "swe", "swe": "swe",
    "norwegian": "nor", "no": "nor", "nor": "nor",
    "danish": "dan", "da": "dan", "dan": "dan",
    "finnish": "fin", "fi": "fin", "fin": "fin",
    "czech": "ces", "cs": "ces", "ces": "ces", "cze": "ces",
    "slovak": "slk", "sk": "slk", "slk": "slk", "slo": "slk",
    "hungarian": "hun", "hu": "hun", "hun": "hun",
    "greek": "ell", "el": "ell", "ell": "ell", "gre": "ell",
    "turkish": "tur", "tr": "tur", "tur": "tur",
    "japanese": "jpn", "ja": "jpn", "jpn": "jpn",
    "korean": "kor", "ko": "kor", "kor": "kor",
    "chinese": "zho", "zh": "zho", "zho": "zho", "chi": "zho",
}


def list_value(value):
    if value is None:
        return []
    values = value if isinstance(value, list) else [value]
    output = []
    seen = set()
    for item in values:
        text = str(item).strip()
        if not text:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        output.append(text)
    return output


def scalar(value):
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def int_value(value):
    if value is None or value == "":
        return None
    number = int(value)
    if number <= 0:
        return None
    return number


def bool_value(value):
    if value is None:
        return None
    return bool(value)


def parse_pair(value):
    text = scalar(value)
    if not text:
        return None, None
    left, _, right = text.partition("/")
    try:
        number = int(left.strip()) if left.strip() else None
    except ValueError:
        number = None
    try:
        total = int(right.strip()) if right.strip() else None
    except ValueError:
        total = None
    return number, total


def format_pair(number, total):
    if number is None:
        return None
    return f"{number}/{total}" if total else str(number)


def language_codes(values):
    result = []
    for value in list_value(values):
        result.append(LANGUAGE_CODES.get(value.casefold(), value))
    return result


def delete_txxx(tags, descriptions):
    wanted = {value.casefold() for value in descriptions}
    for key in list(tags.keys()):
        frame = tags.get(key)
        if isinstance(frame, TXXX) and frame.desc.casefold() in wanted:
            del tags[key]


def set_id3_text(tags, frame_id, frame_type, values):
    tags.delall(frame_id)
    items = list_value(values)
    if items:
        tags.add(frame_type(encoding=3, text=items))


def set_id3_txxx(tags, description, value):
    delete_txxx(tags, [description])
    items = list_value(value)
    if items:
        tags.add(TXXX(encoding=3, desc=description, text=items))


def edit_id3(tags, values):
    text_fields = {
        "title": ("TIT2", TIT2),
        "artists": ("TPE1", TPE1),
        "album": ("TALB", TALB),
        "albumArtists": ("TPE2", TPE2),
        "genres": ("TCON", TCON),
        "releaseDate": ("TDRC", TDRC),
        "originalYear": ("TDOR", TDOR),
        "bpm": ("TBPM", TBPM),
        "initialKey": ("TKEY", TKEY),
        "composers": ("TCOM", TCOM),
        "conductors": ("TPE3", TPE3),
        "publisher": ("TPUB", TPUB),
        "copyright": ("TCOP", TCOP),
        "mood": ("TMOO", TMOO),
        "grouping": ("TIT1", TIT1),
        "isrc": ("TSRC", TSRC),
        "titleSort": ("TSOT", TSOT),
        "artistSort": ("TSOP", TSOP),
        "albumSort": ("TSOA", TSOA),
        "albumArtistSort": ("TSO2", TSO2),
    }
    for field, (frame_id, frame_type) in text_fields.items():
        if field in values:
            value = values[field]
            if field in {"artists", "albumArtists", "genres", "composers", "conductors"}:
                set_id3_text(tags, frame_id, frame_type, value)
            elif field == "bpm":
                set_id3_text(tags, frame_id, frame_type, [] if int_value(value) is None else [str(int_value(value))])
            elif field == "originalYear":
                set_id3_text(tags, frame_id, frame_type, [] if int_value(value) is None else [str(int_value(value))])
            else:
                set_id3_text(tags, frame_id, frame_type, [] if scalar(value) is None else [scalar(value)])

    if "languages" in values:
        set_id3_text(tags, "TLAN", TLAN, language_codes(values["languages"]))

    current_track = parse_pair(tags.getall("TRCK")[0].text[0] if tags.getall("TRCK") and tags.getall("TRCK")[0].text else None)
    current_disc = parse_pair(tags.getall("TPOS")[0].text[0] if tags.getall("TPOS") and tags.getall("TPOS")[0].text else None)

    if "trackNumber" in values or "trackTotal" in values:
        number = int_value(values.get("trackNumber")) if "trackNumber" in values else current_track[0]
        total = int_value(values.get("trackTotal")) if "trackTotal" in values else current_track[1]
        set_id3_text(tags, "TRCK", TRCK, [] if number is None else [format_pair(number, total)])

    if "discNumber" in values or "discTotal" in values:
        number = int_value(values.get("discNumber")) if "discNumber" in values else current_disc[0]
        total = int_value(values.get("discTotal")) if "discTotal" in values else current_disc[1]
        set_id3_text(tags, "TPOS", TPOS, [] if number is None else [format_pair(number, total)])

    if "comment" in values:
        tags.delall("COMM")
        comment = scalar(values["comment"])
        if comment:
            tags.add(COMM(encoding=3, lang="eng", desc="", text=[comment]))

    custom_fields = {
        "countries": "Country",
        "compilation": "COMPILATION",
        "musicbrainzTrackId": "MusicBrainz Track Id",
        "musicbrainzReleaseId": "MusicBrainz Album Id",
        "musicbrainzArtistId": "MusicBrainz Artist Id",
        "musicbrainzAlbumArtistId": "MusicBrainz Album Artist Id",
    }
    for field, description in custom_fields.items():
        if field not in values:
            continue
        value = values[field]
        if field == "compilation":
            value = ["1"] if bool_value(value) else []
        set_id3_txxx(tags, description, value)


def edit_mp3(path, values):
    try:
        tags = ID3(path)
    except ID3NoHeaderError:
        tags = ID3()
    edit_id3(tags, values)
    tags.save(path, v2_version=4)


def edit_wave(path, values):
    audio = WAVE(path)
    if audio.tags is None:
        audio.add_tags()
    edit_id3(audio.tags, values)
    audio.save()


def set_mapping(tags, key, value, multiple=False):
    if value is None or (multiple and not list_value(value)):
        if key in tags:
            del tags[key]
        return
    items = list_value(value) if multiple else [scalar(value)]
    items = [item for item in items if item]
    if items:
        tags[key] = items
    elif key in tags:
        del tags[key]


def mapping_pair(tags, number_key, total_key):
    number = int_value(tags.get(number_key, [None])[0] if tags.get(number_key) else None)
    total = int_value(tags.get(total_key, [None])[0] if tags.get(total_key) else None)
    return number, total


def edit_vorbis(audio, values):
    tags = audio.tags
    if tags is None:
        audio.add_tags()
        tags = audio.tags

    fields = {
        "title": ("title", False),
        "artists": ("artist", True),
        "album": ("album", False),
        "albumArtists": ("albumartist", True),
        "genres": ("genre", True),
        "releaseDate": ("date", False),
        "countries": ("country", True),
        "languages": ("language", True),
        "initialKey": ("initialkey", False),
        "composers": ("composer", True),
        "conductors": ("conductor", True),
        "publisher": ("publisher", False),
        "copyright": ("copyright", False),
        "comment": ("comment", False),
        "mood": ("mood", False),
        "grouping": ("grouping", False),
        "isrc": ("isrc", False),
        "titleSort": ("titlesort", False),
        "artistSort": ("artistsort", False),
        "albumSort": ("albumsort", False),
        "albumArtistSort": ("albumartistsort", False),
        "musicbrainzTrackId": ("musicbrainz_trackid", False),
        "musicbrainzReleaseId": ("musicbrainz_albumid", False),
        "musicbrainzArtistId": ("musicbrainz_artistid", False),
        "musicbrainzAlbumArtistId": ("musicbrainz_albumartistid", False),
    }
    for field, (key, multiple) in fields.items():
        if field in values:
            set_mapping(tags, key, values[field], multiple)

    if "bpm" in values:
        bpm = int_value(values["bpm"])
        set_mapping(tags, "bpm", None if bpm is None else str(bpm))
    if "originalYear" in values:
        year = int_value(values["originalYear"])
        set_mapping(tags, "originaldate", None if year is None else str(year))
    if "compilation" in values:
        set_mapping(tags, "compilation", "1" if bool_value(values["compilation"]) else None)

    current_track = mapping_pair(tags, "tracknumber", "tracktotal")
    current_disc = mapping_pair(tags, "discnumber", "disctotal")
    if "trackNumber" in values:
        set_mapping(tags, "tracknumber", None if int_value(values["trackNumber"]) is None else str(int_value(values["trackNumber"])))
    if "trackTotal" in values:
        set_mapping(tags, "tracktotal", None if int_value(values["trackTotal"]) is None else str(int_value(values["trackTotal"])))
    elif "trackNumber" in values and current_track[1] is not None:
        set_mapping(tags, "tracktotal", str(current_track[1]))
    if "discNumber" in values:
        set_mapping(tags, "discnumber", None if int_value(values["discNumber"]) is None else str(int_value(values["discNumber"])))
    if "discTotal" in values:
        set_mapping(tags, "disctotal", None if int_value(values["discTotal"]) is None else str(int_value(values["discTotal"])))
    elif "discNumber" in values and current_disc[1] is not None:
        set_mapping(tags, "disctotal", str(current_disc[1]))

    audio.save()


def edit_flac(path, values):
    edit_vorbis(FLAC(path), values)


def edit_ogg(path, values):
    edit_vorbis(OggVorbis(path), values)


def edit_opus(path, values):
    edit_vorbis(OggOpus(path), values)


def mp4_freeform_key(name):
    return f"----:com.apple.iTunes:{name}"


def set_mp4_text(tags, key, value, multiple=False):
    if multiple:
        items = list_value(value)
    else:
        item = scalar(value)
        items = [] if item is None else [item]
    if items:
        tags[key] = items
    elif key in tags:
        del tags[key]


def set_mp4_freeform(tags, name, value, multiple=False):
    key = mp4_freeform_key(name)
    items = list_value(value) if multiple else ([] if scalar(value) is None else [scalar(value)])
    if items:
        tags[key] = [item.encode("utf-8") for item in items]
    elif key in tags:
        del tags[key]


def edit_mp4(path, values):
    audio = MP4(path)
    if audio.tags is None:
        audio.add_tags()
    tags = audio.tags

    fields = {
        "title": ("\xa9nam", False),
        "artists": ("\xa9ART", True),
        "album": ("\xa9alb", False),
        "albumArtists": ("aART", True),
        "genres": ("\xa9gen", True),
        "releaseDate": ("\xa9day", False),
        "composers": ("\xa9wrt", True),
        "copyright": ("cprt", False),
        "comment": ("\xa9cmt", False),
        "grouping": ("\xa9grp", False),
        "titleSort": ("sonm", False),
        "artistSort": ("soar", False),
        "albumSort": ("soal", False),
        "albumArtistSort": ("soaa", False),
    }
    for field, (key, multiple) in fields.items():
        if field in values:
            set_mp4_text(tags, key, values[field], multiple)

    if "bpm" in values:
        bpm = int_value(values["bpm"])
        if bpm is None:
            tags.pop("tmpo", None)
        else:
            tags["tmpo"] = [bpm]
    if "compilation" in values:
        tags["cpil"] = [bool(bool_value(values["compilation"]))]

    current_track = (tags.get("trkn") or [(0, 0)])[0]
    current_disc = (tags.get("disk") or [(0, 0)])[0]
    if "trackNumber" in values or "trackTotal" in values:
        number = int_value(values.get("trackNumber")) if "trackNumber" in values else (current_track[0] or None)
        total = int_value(values.get("trackTotal")) if "trackTotal" in values else (current_track[1] or 0)
        if number is None:
            tags.pop("trkn", None)
        else:
            tags["trkn"] = [(number, total or 0)]
    if "discNumber" in values or "discTotal" in values:
        number = int_value(values.get("discNumber")) if "discNumber" in values else (current_disc[0] or None)
        total = int_value(values.get("discTotal")) if "discTotal" in values else (current_disc[1] or 0)
        if number is None:
            tags.pop("disk", None)
        else:
            tags["disk"] = [(number, total or 0)]

    freeform = {
        "countries": ("COUNTRY", True),
        "languages": ("LANGUAGE", True),
        "initialKey": ("INITIALKEY", False),
        "conductors": ("CONDUCTOR", True),
        "publisher": ("PUBLISHER", False),
        "mood": ("MOOD", False),
        "isrc": ("ISRC", False),
        "originalYear": ("ORIGINALYEAR", False),
        "musicbrainzTrackId": ("MusicBrainz Track Id", False),
        "musicbrainzReleaseId": ("MusicBrainz Album Id", False),
        "musicbrainzArtistId": ("MusicBrainz Artist Id", False),
        "musicbrainzAlbumArtistId": ("MusicBrainz Album Artist Id", False),
    }
    for field, (name, multiple) in freeform.items():
        if field in values:
            value = values[field]
            if field == "originalYear":
                year = int_value(value)
                value = None if year is None else str(year)
            set_mp4_freeform(tags, name, value, multiple)

    audio.save()


EDITORS = {
    ".mp3": edit_mp3,
    ".flac": edit_flac,
    ".m4a": edit_mp4,
    ".mp4": edit_mp4,
    ".ogg": edit_ogg,
    ".opus": edit_opus,
    ".wav": edit_wave,
}


def atomic_edit(source, values):
    source = Path(source)
    extension = source.suffix.lower()
    if extension not in SUPPORTED:
        raise ValueError(f"Unsupported metadata format: {extension or 'unknown'}")
    if not source.is_file():
        raise ValueError("Audio file is missing")

    fd, temp_name = tempfile.mkstemp(prefix=".mvbar-meta-", suffix=extension, dir=str(source.parent))
    os.close(fd)
    temp = Path(temp_name)
    try:
        shutil.copy2(source, temp)
        try:
            info = source.stat()
            os.chown(temp, info.st_uid, info.st_gid)
        except (AttributeError, PermissionError, OSError):
            pass

        EDITORS[extension](str(temp), values)

        with temp.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temp, source)
        try:
            directory_fd = os.open(source.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
    finally:
        if temp.exists():
            temp.unlink(missing_ok=True)


def main():
    if len(sys.argv) != 2:
        raise ValueError("Audio file path is required")
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("Metadata payload must be an object")
    atomic_edit(sys.argv[1], payload)
    print(json.dumps({"ok": True, "extension": Path(sys.argv[1]).suffix.lower()}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Metadata update failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)

"""Edit Vorbis comments on a writable staged FLAC file."""

import json
import sys

from mutagen.flac import FLAC


def main():
    audio = FLAC(sys.argv[1])
    values = json.load(sys.stdin)
    keys = {
        "title": "title",
        "album": "album",
        "genre": "genre",
        "artists": "artist",
        "albumArtist": "albumartist",
        "year": "date",
        "trackNumber": "tracknumber",
        "discNumber": "discnumber",
        "country": "country",
        "language": "language",
    }
    for field, tag in keys.items():
        if field not in values:
            continue
        value = values[field]
        items = value if isinstance(value, list) else [value]
        items = [str(item).strip() for item in items if item is not None and str(item).strip()]
        if items:
            audio[tag] = items
        elif tag in audio:
            del audio[tag]
    audio.save()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FLAC metadata update failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)

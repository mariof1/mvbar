# Shared artwork icons

The first pair of MVBar icons replaces missing album and artist artwork in web browse/detail/search and the Android phone's album/artist cards and details. Other media types and the TV/Wear clients can adopt the set incrementally.

The visual language is a 24-unit viewport, 1.5-unit strokes, round caps and joins, no fill, and a single tint supplied by the UI. Album uses a record inside a sleeve; artist uses a portrait outline. Keep these silhouettes legible at 20 px and avoid emoji or embedded text. Existing artwork always takes priority; loading, missing and failed images retain a stable placeholder tile.

## Source and synchronization

Edit `web/app/icons/artwork-icons.json` in this repository. The web `ArtworkImage` / `ArtworkIcon` components read it directly. With the Android repository checked out beside this one, run:

```sh
node scripts/sync-artwork-icons.mjs
node scripts/sync-artwork-icons.mjs --check
```

The generator writes `app/src/main/java/com/mvbar/android/ui/components/ArtworkIcons.kt` in the sibling `mvbar-android` repo. Commit the source and generated snapshot in their respective repositories after validation. The Android build does not require the web checkout or a network download; both apps build independently. Do not edit generated Kotlin paths manually.

Use `ArtworkImage` with `kind="album"` or `kind="artist"` on web and `ArtworkIcons.Album` / `ArtworkIcons.Artist` for Android `ArtworkImage` placeholders. The web wrapper owns the accessible artwork name; the inner SVG and image are decorative. Android continues using the existing artwork component's semantics.

// Keep the largest cover first for older WebKit releases that only inspect the
// first Media Session artwork candidate instead of selecting by `sizes`.
const MEDIA_SESSION_ARTWORK_SIZES = [512, 384, 256, 192, 128, 96] as const;

/**
 * Build artwork metadata that Chromium-based system media controls can select
 * reliably. Dynamic artwork keeps its server-provided Content-Type rather than
 * claiming every cover is a JPEG (covers can also be PNG or WebP).
 */
export function mediaSessionArtwork(src?: string | null) {
  const absoluteFallback = new URL('/icon-512.png', window.location.origin).href;

  if (!src) {
    return [
      { src: absoluteFallback, sizes: '512x512', type: 'image/png' },
    ];
  }

  const absoluteSrc = new URL(src, window.location.origin).href;

  // Do not append the app icon here. On mobile Chromium it competes with the
  // real 512px cover and can be selected for the media notification instead.
  return MEDIA_SESSION_ARTWORK_SIZES.map((size) => ({
    src: absoluteSrc,
    sizes: `${size}x${size}`,
  }));
}

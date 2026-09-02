const MEDIA_SESSION_ARTWORK_SIZES = [96, 128, 192, 256, 384, 512] as const;

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

  return [
    ...MEDIA_SESSION_ARTWORK_SIZES.map((size) => ({
      src: absoluteSrc,
      sizes: `${size}x${size}`,
    })),
    { src: absoluteFallback, sizes: '512x512', type: 'image/png' },
  ];
}

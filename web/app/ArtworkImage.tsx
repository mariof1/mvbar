'use client';

import { useState } from 'react';
import artworkIcons from './icons/artwork-icons.json';

export type ArtworkKind = keyof typeof artworkIcons.icons;

/** Shared geometry also generates Android's native ArtworkIcons. */
export function ArtworkIcon({ kind, className = '' }: { kind: ArtworkKind; className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={artworkIcons.strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d={artworkIcons.icons[kind]} />
    </svg>
  );
}

/** Keeps a stable tile for missing, loading and failed artwork; retries a changed URL. */
export function ArtworkImage({ src, alt, kind, className = '' }: {
  src?: string | null; alt: string; kind: ArtworkKind; className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <span role="img" aria-label={alt || `${kind === 'album' ? 'Album' : 'Artist'} artwork`}
      className={`relative block overflow-hidden bg-slate-800 ${className}`}>
      <span className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-700/40 to-slate-900/40 text-slate-400">
        <ArtworkIcon kind={kind} className="h-1/2 w-1/2 max-h-20 max-w-20" />
      </span>
      {src && failedSrc !== src && (
        <img key={src} src={src} alt="" loading="lazy"
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setFailedSrc(src)} />
      )}
    </span>
  );
}

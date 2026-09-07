'use client';

import { useEffect, useRef, useState } from 'react';

export function RemoteSeekSlider({ position, duration, label, onSeek }: {
  position: number; duration: number; label: string; onSeek: (position: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const draftRef = useRef<number | null>(null);
  const lastPosition = useRef(position);
  const maximum = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const displayed = Math.max(0, Math.min(maximum, draft ?? position));

  useEffect(() => {
    const changed = lastPosition.current !== position;
    lastPosition.current = position;
    if (changed && !dragging && draft !== null && Math.abs(position - draft) < 1500) setDraft(null);
  }, [position, dragging, draft]);
  useEffect(() => {
    if (draft === null || dragging) return;
    // A failed/offline receiver may never publish the requested position.
    const timer = window.setTimeout(() => setDraft(null), 5000);
    return () => window.clearTimeout(timer);
  }, [draft, dragging]);

  return <input type="range" min={0} max={maximum || 1} step={1000}
    value={displayed} disabled={!maximum} aria-label={label}
    className="absolute -top-1 left-0 h-2 w-full cursor-pointer accent-cyan-500 disabled:cursor-default"
    onPointerDown={(event) => {
      draggingRef.current = true;
      draftRef.current = null;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onChange={(event) => {
      const value = Number(event.currentTarget.value);
      draftRef.current = value;
      setDraft(value);
      if (!draggingRef.current) onSeek(value);
    }}
    onPointerUp={() => {
      if (draggingRef.current && draftRef.current !== null) onSeek(draftRef.current);
      draggingRef.current = false;
      setDragging(false);
    }}
    onPointerCancel={() => {
      draggingRef.current = false;
      draftRef.current = null;
      setDragging(false);
      setDraft(null);
    }}
  />;
}

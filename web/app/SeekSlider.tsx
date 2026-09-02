import type { CSSProperties } from 'react';

export function SeekSlider({
  currentTime,
  duration,
  onSeek,
  accent,
  label,
  compact = false,
}: {
  currentTime: number;
  duration: number;
  onSeek: (position: number) => void;
  accent: string;
  label: string;
  compact?: boolean;
}) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safeCurrentTime = safeDuration > 0
    ? Math.max(0, Math.min(Number.isFinite(currentTime) ? currentTime : 0, safeDuration))
    : 0;
  const progress = safeDuration > 0 ? (safeCurrentTime / safeDuration) * 100 : 0;

  return (
    <input
      type="range"
      min={0}
      max={safeDuration || 1}
      step={0.1}
      value={safeCurrentTime}
      disabled={!safeDuration}
      aria-label={label}
      onChange={(event) => onSeek(Number(event.currentTarget.value))}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      className={`seek-slider${compact ? ' seek-slider--compact' : ''}`}
      style={{
        '--seek-progress': `${progress}%`,
        '--seek-color': accent,
      } as CSSProperties}
    />
  );
}

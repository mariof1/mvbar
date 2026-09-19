'use client';

import { usePlayer } from './playerStore';
import { useMvbarConnect } from './useWebSocket';

export function usePlayingTrackId(): number | null {
  const localPlayingTrackId = usePlayer((state) => {
    if (!state.isOpen || !state.isPlaying) return null;
    const id = Number(state.queue[state.index]?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  });
  const localDeviceId = useMvbarConnect((state) => state.localDeviceId);
  const selectedDevice = useMvbarConnect((state) => (
    state.devices.find((device) => device.id === state.selectedDeviceId) ?? null
  ));

  if (selectedDevice && selectedDevice.id !== localDeviceId) {
    if (!selectedDevice.state.isPlaying || !selectedDevice.state.track) return null;
    const id = Number(selectedDevice.state.track.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  return localPlayingTrackId;
}

export function PlayingTrackIndicator({
  trackId,
  className = '',
}: {
  trackId: number | string | null | undefined;
  className?: string;
}) {
  const playingTrackId = usePlayingTrackId();
  const id = Number(trackId);
  if (!Number.isFinite(id) || id <= 0 || playingTrackId !== id) return null;

  return (
    <span
      data-playing-track-indicator
      data-track-id={id}
      aria-label="Now playing"
      title="Now playing"
      className={`inline-flex h-4 w-4 flex-none items-center justify-center text-cyan-400 ${className}`}
    >
      <svg className="h-4 w-4 animate-pulse motion-reduce:animate-none" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <rect x="1" y="6" width="2.5" height="6" rx="1" />
        <rect x="6.75" y="2" width="2.5" height="10" rx="1" />
        <rect x="12.5" y="4" width="2.5" height="8" rx="1" />
      </svg>
    </span>
  );
}

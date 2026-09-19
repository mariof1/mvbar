'use client';

import { usePlayer } from './playerStore';
import { useMvbarConnect } from './useWebSocket';

export function usePlayingTrackId(): number | null {
  const localPlayingTrackId = usePlayer((state) => {
    if (!state.isOpen || !state.isPlaying) return null;
    const id = Number(state.queue[state.index]?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  });
  const remotePlayingTrackId = useMvbarConnect((state) => {
    const selectedDevice = state.devices.find((device) => device.id === state.selectedDeviceId) ?? null;
    if (!selectedDevice || selectedDevice.id === state.localDeviceId) return undefined;
    if (!selectedDevice.state.isPlaying || !selectedDevice.state.track) return null;
    const id = Number(selectedDevice.state.track.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  });

  return remotePlayingTrackId === undefined ? localPlayingTrackId : remotePlayingTrackId;
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
      <span className="mvbar-playing-equalizer" aria-hidden="true">
        <span className="mvbar-playing-equalizer__bar" />
        <span className="mvbar-playing-equalizer__bar" />
        <span className="mvbar-playing-equalizer__bar" />
        <span className="mvbar-playing-equalizer__bar" />
      </span>
    </span>
  );
}

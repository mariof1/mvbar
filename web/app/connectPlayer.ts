'use client';

import { useCallback } from 'react';
import { usePlayer, type QueueTrack } from './playerStore';
import {
  sendMvbarConnectCommand,
  type MvbarConnectTrack,
  useMvbarConnect,
} from './useWebSocket';
import { useToastStore } from './Toast';
import { closePodcastPlayer, closeAudiobookPlayer } from './uiStore';

function asConnectTrack(track: QueueTrack): MvbarConnectTrack {
  return {
    id: Number(track.id),
    title: track.title ?? null,
    artist: track.artist ?? null,
    album: track.album ?? null,
    artPath: track.art_path ?? null,
    durationMs: track.duration_ms ?? null,
  };
}

/**
 * The single playback dispatcher for UI components that may control another
 * MVBar player. Incoming remote commands deliberately use usePlayer directly
 * so they are always executed on this device and cannot bounce back remotely.
 */
export function useConnectPlayer() {
  const player = usePlayer();
  const localDeviceId = useMvbarConnect((state) => state.localDeviceId);
  const selectedDevice = useMvbarConnect((state) => (
    state.devices.find((device) => device.id === state.selectedDeviceId) ?? null
  ));
  const showToast = useToastStore((state) => state.show);
  const remoteTarget = selectedDevice && selectedDevice.id !== localDeviceId ? selectedDevice : null;

  const sendTracks = useCallback((command: 'play_tracks' | 'add_tracks' | 'play_next', tracks: QueueTrack[], extra: Record<string, unknown> = {}) => {
    if (!remoteTarget || tracks.length === 0) return false;
    if (command === 'play_tracks') {
      closePodcastPlayer();
      closeAudiobookPlayer();
    }
    const commandId = sendMvbarConnectCommand(remoteTarget.id, command, {
      tracks: tracks.map(asConnectTrack),
      ...extra,
    });
    if (commandId && command !== 'play_tracks') showToast(`Queue update sent to ${remoteTarget.name}`, 'queue');
    return true;
  }, [remoteTarget, showToast]);

  return {
    ...player,
    setQueueAndPlay: (tracks: QueueTrack[], startIndex: number) => {
      if (!sendTracks('play_tracks', tracks, { queueIndex: startIndex, positionMs: 0, isPlaying: true })) {
        player.setQueueAndPlay(tracks, startIndex);
      }
    },
    playTrackNow: (track: QueueTrack) => {
      if (!sendTracks('play_tracks', [track], { queueIndex: 0, positionMs: 0, isPlaying: true })) {
        player.playTrackNow(track);
      }
    },
    playIndex: (index: number) => {
      if (remoteTarget) sendMvbarConnectCommand(remoteTarget.id, 'play_index', { index });
      else player.playIndex(index);
    },
    addToQueue: (track: QueueTrack) => {
      if (!sendTracks('add_tracks', [track])) player.addToQueue(track);
    },
    addManyToQueue: (tracks: QueueTrack[]) => {
      if (!sendTracks('add_tracks', tracks)) player.addManyToQueue(tracks);
    },
    playNext: (track: QueueTrack) => {
      if (!sendTracks('play_next', [track])) player.playNext(track);
    },
    playNextMany: (tracks: QueueTrack[]) => {
      if (!sendTracks('play_next', tracks)) player.playNextMany(tracks);
    },
    removeFromQueue: (index: number) => {
      if (remoteTarget) sendMvbarConnectCommand(remoteTarget.id, 'remove_index', { index });
      else player.removeFromQueue(index);
    },
    reorderQueue: (from: number, to: number) => {
      if (remoteTarget) sendMvbarConnectCommand(remoteTarget.id, 'reorder', { from, to });
      else player.reorderQueue(from, to);
    },
    clearQueue: () => {
      if (remoteTarget) sendMvbarConnectCommand(remoteTarget.id, 'clear_queue');
      else player.clearQueue();
    },
    next: () => {
      if (remoteTarget) sendMvbarConnectCommand(remoteTarget.id, 'next');
      else player.next();
    },
    prev: () => {
      if (remoteTarget) sendMvbarConnectCommand(remoteTarget.id, 'previous');
      else player.prev();
    },
    close: () => {
      if (remoteTarget) sendMvbarConnectCommand(remoteTarget.id, 'stop');
      else player.close();
    },
  };
}

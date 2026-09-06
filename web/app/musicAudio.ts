'use client';

import { useToastStore } from './Toast';

export const MUSIC_AUDIO_ELEMENT_ID = 'mvbar-music-audio';

let playbackAttempt = 0;
let lastPlaybackErrorAt = 0;

type AudioSessionNavigator = Navigator & {
  audioSession?: {
    type: 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';
  };
};

export function prepareSystemPlaybackSession(): void {
  if (typeof navigator === 'undefined') return;

  // Safari exposes the Audio Session API. Declaring long-form playback keeps
  // music eligible for background/lock-screen playback instead of treating it
  // like a short page sound. Chromium does not expose this API yet and simply
  // follows the HTMLAudioElement's normal playback audio focus.
  try {
    const audioSession = (navigator as AudioSessionNavigator).audioSession;
    if (audioSession) audioSession.type = 'playback';
  } catch {}
}

export function publishSystemPlaybackState(state: MediaSessionPlaybackState): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try { navigator.mediaSession.playbackState = state; } catch {}
}

export function getMusicAudioElement(): HTMLAudioElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(MUSIC_AUDIO_ELEMENT_ID) as HTMLAudioElement | null;
}

export function directMusicStreamUrl(trackId: number): string {
  return `/api/stream/${trackId}`;
}

/**
 * Start playback while the browser still considers the caller's click/tap an
 * active user gesture. Waiting for React to mount the player first is too late
 * on mobile browsers with strict autoplay policies.
 */
export function startMusicPlayback(trackId: number): Promise<void> | null {
  const audio = getMusicAudioElement();
  if (!audio) return null;

  prepareSystemPlaybackSession();
  playbackAttempt += 1;
  const attempt = playbackAttempt;
  const streamUrl = directMusicStreamUrl(trackId);
  if (audio.getAttribute('src') !== streamUrl) {
    audio.src = streamUrl;
  }
  audio.dataset.mvbarPlaybackState = 'pending';
  delete audio.dataset.mvbarPlaybackError;
  const playPromise = audio.play();
  playPromise.then(
    () => {
      if (attempt === playbackAttempt) {
        audio.dataset.mvbarPlaybackState = 'playing';
        // The first play event can happen before PlayerBar mounts and attaches
        // its listeners. Publish the state here as well so Android obtains a
        // full system media session from the very first tap.
        publishSystemPlaybackState('playing');
      }
    },
    (error: unknown) => {
      if (attempt === playbackAttempt) {
        audio.dataset.mvbarPlaybackState = 'failed';
        audio.dataset.mvbarPlaybackError = error && typeof error === 'object' && 'name' in error
          ? String((error as { name?: unknown }).name || '')
          : 'PlaybackError';
      }
    }
  );
  return playPromise;
}

export function stopMusicPlayback(clearSource = false): void {
  playbackAttempt += 1;
  const audio = getMusicAudioElement();
  if (!audio) return;

  audio.pause();
  audio.dataset.mvbarPlaybackState = 'idle';
  publishSystemPlaybackState('none');
  delete audio.dataset.mvbarPlaybackError;
  if (clearSource) {
    audio.removeAttribute('src');
    audio.load();
  }
}

export function currentMusicPlaybackAttempt(): number {
  return playbackAttempt;
}

export function reportMusicPlaybackFailure(error?: unknown): void {
  const errorName = error && typeof error === 'object' && 'name' in error
    ? String((error as { name?: unknown }).name || '')
    : '';
  if (errorName === 'AbortError') return;

  // A rejected play promise and the media element's error event can describe
  // the same failure. Keep that from producing duplicate notifications.
  const now = Date.now();
  if (now - lastPlaybackErrorAt < 1500) return;
  lastPlaybackErrorAt = now;

  useToastStore.getState().show(
    errorName === 'NotAllowedError'
      ? 'Playback was blocked by the browser. Tap Play to continue.'
      : 'Could not start playback. Tap Play to retry.',
    'error'
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import {
  sendMvbarConnectCommand,
  type MvbarConnectDevice,
  useMvbarConnect,
} from './useWebSocket';

function DeviceIcon({ active = false }: { active?: boolean }) {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
      {active && <circle cx="17" cy="8" r="2" fill="currentColor" stroke="none" />}
    </svg>
  );
}

export function MvbarConnectButton({
  onSelect,
  compact = false,
}: {
  onSelect: (device: MvbarConnectDevice) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const devices = useMvbarConnect((state) => state.devices);
  const selectedDeviceId = useMvbarConnect((state) => state.selectedDeviceId);
  const localDeviceId = useMvbarConnect((state) => state.localDeviceId);
  const selected = devices.find((device) => device.id === selectedDeviceId);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`relative inline-flex items-center justify-center rounded-xl border transition-all ${
          selectedDeviceId && selectedDeviceId !== localDeviceId
            ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-300'
            : 'border-white/10 bg-white/5 text-slate-400 hover:border-white/20 hover:bg-white/10 hover:text-white'
        } ${compact ? 'h-9 w-9' : 'h-10 gap-2 px-3'}`}
        aria-label="MVBar Connect players"
        aria-expanded={open}
        title={selected ? `Playing on ${selected.name}` : 'MVBar Connect'}
      >
        <DeviceIcon active={Boolean(selected?.state.isPlaying)} />
        {!compact && <span className="hidden xl:inline text-sm">{selected?.name || 'Connect'}</span>}
        {devices.length > 1 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-500 px-1 text-[9px] font-bold text-black">
            {devices.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-[80] mt-2 w-[min(21rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/98 shadow-2xl backdrop-blur-xl">
          <div className="border-b border-white/10 px-4 py-3">
            <p className="font-semibold text-white">MVBar Connect</p>
            <p className="mt-0.5 text-xs text-white/45">Choose where playback happens</p>
          </div>
          <div className="max-h-80 overflow-y-auto p-2">
            {devices.map((device) => {
              const isSelected = device.id === selectedDeviceId;
              const isLocal = device.id === localDeviceId;
              return (
                <button
                  type="button"
                  key={device.id}
                  onClick={() => {
                    onSelect(device);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition ${
                    isSelected ? 'bg-cyan-500/15 text-cyan-200' : 'text-white hover:bg-white/[0.07]'
                  }`}
                >
                  <span className={`flex h-10 w-10 flex-none items-center justify-center rounded-xl ${isSelected ? 'bg-cyan-500/20' : 'bg-white/[0.06]'}`}>
                    <DeviceIcon active={device.state.isPlaying} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{device.name}</span>
                      {isLocal && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/50">This device</span>}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-white/45">
                      {device.state.track
                        ? `${device.state.isPlaying ? 'Playing' : 'Paused'} · ${device.state.track.title || 'Untitled'}`
                        : [device.type.toUpperCase(), device.platform].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className={`h-2.5 w-2.5 flex-none rounded-full ${device.state.isPlaying ? 'bg-emerald-400' : isSelected ? 'bg-cyan-400' : 'bg-white/20'}`} />
                </button>
              );
            })}
            {devices.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-white/45">Connecting this player…</p>
            )}
          </div>
          <p className="border-t border-white/10 px-4 py-3 text-[11px] leading-relaxed text-white/35">
            Only players signed in to this MVBar account are visible.
          </p>
        </div>
      )}
    </div>
  );
}

export function MvbarRemotePlayerBar({
  device,
  onChooseDevice,
}: {
  device: MvbarConnectDevice;
  onChooseDevice: (device: MvbarConnectDevice) => void;
}) {
  const track = device.state.track;
  const duration = Math.max(0, device.state.durationMs);
  const position = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, device.state.positionMs));

  if (!track) return null;

  const command = (name: string, payload: Record<string, unknown> = {}) =>
    sendMvbarConnectCommand(device.id, name, payload);

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 h-[76px] border-t border-white/10 bg-zinc-950/95 shadow-2xl backdrop-blur-xl lg:left-64">
      <input
        type="range"
        min={0}
        max={Math.max(1, duration)}
        value={position}
        onChange={(event) => command('seek', { positionMs: Number(event.target.value) })}
        aria-label={`Seek on ${device.name}`}
        className="absolute -top-1 left-0 h-2 w-full cursor-pointer accent-cyan-500"
      />
      <div className="mx-auto flex h-full max-w-screen-2xl items-center gap-3 px-3 sm:px-4">
        <img
          src={`/api/library/tracks/${track.id}/art`}
          alt=""
          className="h-12 w-12 flex-none rounded-lg bg-white/5 object-cover"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{track.title || `Track #${track.id}`}</p>
          <p className="truncate text-xs text-white/50">{track.artist || 'Unknown artist'} · {device.name}</p>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <button type="button" onClick={() => command('previous')} className="rounded-full p-2 text-white/70 hover:bg-white/10" aria-label={`Previous on ${device.name}`}>
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z" /></svg>
          </button>
          <button type="button" onClick={() => command('toggle')} className="rounded-full bg-white p-2.5 text-black" aria-label={`${device.state.isPlaying ? 'Pause' : 'Play'} on ${device.name}`}>
            {device.state.isPlaying ? (
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /></svg>
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            )}
          </button>
          <button type="button" onClick={() => command('next')} className="rounded-full p-2 text-white/70 hover:bg-white/10" aria-label={`Next on ${device.name}`}>
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2V6zm-1.5 6L6 18V6l8.5 6z" /></svg>
          </button>
          <MvbarConnectButton onSelect={onChooseDevice} compact />
        </div>
      </div>
    </div>
  );
}

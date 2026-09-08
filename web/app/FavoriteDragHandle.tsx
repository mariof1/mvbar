'use client';

import { useEffect, useRef, useState } from 'react';

/** A dedicated handle leaves the rest of the row available for normal touch scrolling. */
export function FavoriteDragHandle({ label, disabled, onHover, onDrop, onCancel, onStep }: {
  label: string; disabled: boolean;
  onHover: (id: number, after: boolean) => void;
  onDrop: () => void; onCancel: () => void;
  onStep: (direction: -1 | 1) => void;
}) {
  const [active, setActive] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ timer: ReturnType<typeof setTimeout>; active: boolean; x: number; y: number; startX: number; startY: number; frame: number; cleanup: () => void } | null>(null);
  const callbacks = useRef({ onHover, onDrop, onCancel });
  callbacks.current = { onHover, onDrop, onCancel };
  function finish(cancel: boolean) {
    const state = drag.current;
    if (!state) return;
    clearTimeout(state.timer);
    cancelAnimationFrame(state.frame);
    drag.current = null;
    state.cleanup();
    setActive(false);
    if (state.active) callbacks.current[cancel ? 'onCancel' : 'onDrop']();
  }
  useEffect(() => () => {
    // React can disconnect effects while moving a row; only dispose a removed handle.
    queueMicrotask(() => {
      if (!button.current?.isConnected && drag.current) {
        clearTimeout(drag.current.timer);
        cancelAnimationFrame(drag.current.frame);
        drag.current.cleanup();
      }
    });
  }, []);
  return <button ref={button} type="button" aria-label={`Reorder ${label}`} aria-pressed={active}
    title="Hold and drag to reorder. Use arrow keys to move."
    disabled={disabled} data-reorder-handle
    className={`h-11 w-11 shrink-0 touch-none select-none rounded-lg text-slate-400 focus-visible:ring-2 focus-visible:ring-cyan-500 ${active ? 'bg-cyan-500/20 cursor-grabbing' : 'cursor-grab hover:bg-slate-800'}`}
    onContextMenu={event => event.preventDefault()}
    onClick={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.key === 'Escape') finish(true);
      if (!drag.current && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault(); onStep(event.key === 'ArrowUp' ? -1 : 1);
      }
    }}
    onPointerDown={event => {
      if (disabled || event.button !== 0 || drag.current) return;
      // Capture on the stable list: moving a keyed row in the DOM releases that row's capture.
      const owner = event.currentTarget.closest<HTMLElement>('[data-favorites-list]')!;
      const pointerId = event.pointerId;
      owner.setPointerCapture(pointerId);
      const state = { timer: setTimeout(() => {}, 0), active: false, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, frame: 0, cleanup: () => {} };
      const move = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        state.x = event.clientX; state.y = event.clientY;
        if (!state.active && Math.hypot(state.x - state.startX, state.y - state.startY) > 10) finish(true);
      };
      const up = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(false); };
      const cancel = () => finish(true);
      const key = (event: KeyboardEvent) => { if (event.key === 'Escape') finish(true); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('keydown', key);
      window.addEventListener('blur', cancel);
      state.cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('keydown', key);
        window.removeEventListener('blur', cancel);
        if (owner.hasPointerCapture(pointerId)) owner.releasePointerCapture(pointerId);
      };
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.active = true; setActive(true);
        const tick = () => {
          if (drag.current !== state) return;
          const element = document.elementFromPoint(state.x, state.y);
          const row = element?.closest<HTMLElement>('[data-favorite-id]');
          if (row) {
            const bounds = row.getBoundingClientRect();
            callbacks.current.onHover(Number(row.dataset.favoriteId), state.y > bounds.top + bounds.height / 2);
          }
          let scroll: HTMLElement | null = element instanceof HTMLElement ? element : null;
          while (scroll && !(scroll.scrollHeight > scroll.clientHeight && /auto|scroll/.test(getComputedStyle(scroll).overflowY))) scroll = scroll.parentElement;
          const bounds = scroll?.getBoundingClientRect();
          const top = Math.max(0, bounds?.top ?? 0);
          const bottom = Math.min(innerHeight, bounds?.bottom ?? innerHeight);
          const amount = state.y < top + 48 ? -8 : state.y > bottom - 48 ? 8 : 0;
          if (amount) { if (scroll) scroll.scrollTop += amount; else window.scrollBy(0, amount); }
          state.frame = requestAnimationFrame(tick);
        };
        tick();
      }, 300);
      drag.current = state;
    }}
  >
    <svg aria-hidden="true" className="mx-auto h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
      {[6, 12, 18].map(y => <g key={y}><circle cx="9" cy={y} r="1.5" /><circle cx="15" cy={y} r="1.5" /></g>)}
    </svg>
  </button>;
}

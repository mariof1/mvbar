'use client';

import React from 'react';
import { create } from 'zustand';
import { useEffect, useState, useCallback } from 'react';

type ToastItem = { id: number; message: string; icon?: 'queue' | 'success' | 'error' };

type ToastState = {
  toasts: ToastItem[];
  show: (message: string, icon?: ToastItem['icon']) => void;
  dismiss: (id: number) => void;
};

let _nextId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (message, icon) => {
    const id = ++_nextId;
    set((s) => ({ toasts: [...s.toasts, { id, message, icon }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2400);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

const icons: Record<string, React.ReactElement> = {
  queue: (
    <svg className="w-5 h-5 text-cyan-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7" />
    </svg>
  ),
  success: (
    <svg className="w-5 h-5 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  ),
  error: (
    <svg className="w-5 h-5 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  ),
};

function ToastSlice({ item, onDone }: { item: ToastItem; onDone: () => void }) {
  const [phase, setPhase] = useState<'enter' | 'visible' | 'exit'>('enter');

  useEffect(() => {
    requestAnimationFrame(() => setPhase('visible'));
    const timer = setTimeout(() => setPhase('exit'), 2000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (phase === 'exit') {
      const t = setTimeout(onDone, 350);
      return () => clearTimeout(t);
    }
  }, [phase, onDone]);

  return (
    <div
      className={`
        flex items-center gap-2.5 px-4 py-2.5 rounded-xl
        bg-slate-800/90 backdrop-blur-md border border-white/10 shadow-lg shadow-black/30
        text-sm text-white pointer-events-auto select-none
        transition-all duration-300 ease-out
        ${phase === 'enter' ? 'opacity-0 translate-y-3 scale-95' : ''}
        ${phase === 'visible' ? 'opacity-100 translate-y-0 scale-100' : ''}
        ${phase === 'exit' ? 'opacity-0 -translate-y-1 scale-95' : ''}
      `}
    >
      {item.icon && icons[item.icon]}
      <span className="truncate max-w-[260px]">{item.message}</span>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const handleDone = useCallback((id: number) => dismiss(id), [dismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[250] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastSlice key={t.id} item={t} onDone={() => handleDone(t.id)} />
      ))}
    </div>
  );
}

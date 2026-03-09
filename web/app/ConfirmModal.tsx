'use client';

import React, { useEffect, useRef } from 'react';
import { create } from 'zustand';

type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type ConfirmState = {
  open: boolean;
  options: ConfirmOptions | null;
  resolve: ((ok: boolean) => void) | null;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  close: (result: boolean) => void;
};

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  open: false,
  options: null,
  resolve: null,

  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      set({ open: true, options: opts, resolve });
    }),

  close: (result) => {
    const { resolve } = get();
    resolve?.(result);
    set({ open: false, options: null, resolve: null });
  },
}));

/** Shorthand: await confirm({ title, message }) */
export const showConfirm = (opts: ConfirmOptions) =>
  useConfirmStore.getState().confirm(opts);

/** Shorthand for alert-style (no cancel, just OK) */
export const showAlert = (title: string, message: string) =>
  useConfirmStore.getState().confirm({ title, message, confirmLabel: 'OK', cancelLabel: '' });

export function ConfirmModal() {
  const { open, options, close } = useConfirmStore();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, close]);

  if (!open || !options) return null;

  const { title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = options;
  const showCancel = cancelLabel !== '';

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => close(false)}
    >
      <div
        className="bg-slate-800 border border-slate-700/60 rounded-2xl shadow-2xl shadow-black/40 p-6 max-w-sm w-[90vw] mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
        <p className="text-sm text-slate-300 mb-6 leading-relaxed">{message}</p>
        <div className="flex items-center justify-end gap-3">
          {showCancel && (
            <button
              onClick={() => close(false)}
              className="px-4 py-2 text-sm rounded-lg text-slate-300 hover:text-white hover:bg-slate-700/60 transition-colors"
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmRef}
            onClick={() => close(true)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              danger
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-cyan-600 hover:bg-cyan-500 text-white'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

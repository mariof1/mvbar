'use client';

import React, { useRef } from 'react';
import { create } from 'zustand';
import { useDialogFocus } from './useDialogFocus';
import { useBodyScrollLock } from './useBodyScrollLock';

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
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, () => close(false), open);
  useBodyScrollLock(open);

  if (!open || !options) return null;

  const { title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = options;
  const showCancel = cancelLabel !== '';

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={() => close(false)}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-800 shadow-2xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-h-0 overflow-y-auto overscroll-contain break-words p-5 sm:p-6">
          <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
          <p className="text-sm text-slate-300 leading-relaxed">{message}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-white/10 px-5 py-3 sm:px-6">
          {showCancel && (
            <button
              onClick={() => close(false)}
              className="min-h-11 px-4 py-2 text-sm rounded-lg text-slate-300 hover:text-white hover:bg-slate-700/60 transition-colors"
            >
              {cancelLabel}
            </button>
          )}
          <button
            onClick={() => close(true)}
            className={`min-h-11 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
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

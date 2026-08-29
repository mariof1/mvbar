'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  enablePushNotifications,
  inspectPushNotifications,
  type PushNotificationState,
  unsubscribeCurrentPushDevice,
} from './pushNotifications';

const initialState: PushNotificationState = { status: 'loading', publicKey: null };

export function PushNotificationSettings({ token }: { token: string }) {
  const [state, setState] = useState<PushNotificationState>(initialState);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState(initialState);
    try {
      setState(await inspectPushNotifications(token));
    } catch (error) {
      setState({
        status: 'error',
        publicKey: null,
        detail: error instanceof Error ? error.message : 'Could not check notification support.',
      });
    }
  }, [token]);

  useEffect(() => { void refresh(); }, [refresh]);

  const enable = async () => {
    if (!state.publicKey) return;
    setBusy(true);
    setNotice(null);
    try {
      await enablePushNotifications(token, state.publicKey);
      setNotice('Notifications are enabled on this device.');
    } catch (error) {
      const permissionDenied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
      setNotice(permissionDenied
        ? 'Notifications were blocked. Allow them in this browser or device settings and try again.'
        : error instanceof Error ? error.message : 'Could not enable notifications.');
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const disable = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await unsubscribeCurrentPushDevice(token);
      setNotice('Notifications are disabled on this device.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not disable notifications.');
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const enabled = state.status === 'enabled';
  const canEnable = state.status === 'disabled';

  return (
    <section className="space-y-4 rounded-xl bg-slate-800/50 p-4 sm:p-6">
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 flex h-10 w-10 flex-none items-center justify-center rounded-full ${enabled ? 'bg-green-500/15 text-green-400' : 'bg-slate-700 text-slate-400'}`}>
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9a6 6 0 00-12 0v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-white">Friends &amp; sharing notifications</h2>
          <p className="mt-1 text-sm text-slate-400">
            Receive a device notification when someone sends a friend request, accepts your request, or shares a song with you—even when mvbar is closed.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-slate-900/50 p-4">
        {state.status === 'loading' && <p className="text-sm text-slate-400">Checking this device…</p>}
        {enabled && <p className="text-sm font-medium text-green-400">Enabled on this device</p>}
        {canEnable && <p className="text-sm text-slate-300">Notifications are currently off on this device.</p>}
        {state.status === 'denied' && (
          <div className="space-y-1">
            <p className="text-sm font-medium text-amber-400">Notifications are blocked</p>
            <p className="text-sm text-slate-400">Allow notifications for this site in your browser or device settings, then reload mvbar.</p>
          </div>
        )}
        {state.status === 'needs-install' && (
          <div className="space-y-1">
            <p className="text-sm font-medium text-amber-400">Add mvbar to your Home Screen first</p>
            <p className="text-sm text-slate-400">On iPhone or iPad, use Share → Add to Home Screen, open mvbar from its new icon, then return here.</p>
          </div>
        )}
        {state.status === 'unsupported' && <p className="text-sm text-amber-400">{state.detail || 'This browser does not support Web Push.'}</p>}
        {state.status === 'unconfigured' && <p className="text-sm text-amber-400">Web Push has not been configured on this mvbar server yet.</p>}
        {state.status === 'error' && <p className="text-sm text-red-400">{state.detail || 'Could not initialize notifications.'}</p>}
      </div>

      <div className="flex flex-wrap gap-2">
        {canEnable && (
          <button
            type="button"
            onClick={() => void enable()}
            disabled={busy}
            className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
          >
            {busy ? 'Enabling…' : 'Enable notifications'}
          </button>
        )}
        {enabled && (
          <button
            type="button"
            onClick={() => void disable()}
            disabled={busy}
            className="rounded-lg bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-400 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Disabling…' : 'Disable on this device'}
          </button>
        )}
        {(state.status === 'denied' || state.status === 'error') && (
          <button type="button" onClick={() => void refresh()} className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-600">
            Check again
          </button>
        )}
      </div>

      {notice && <p className={`text-sm ${enabled ? 'text-green-400' : 'text-slate-300'}`}>{notice}</p>}
      <p className="text-xs text-slate-500">This preference applies only to this browser or installed web app. You can enable it independently on each device.</p>
    </section>
  );
}

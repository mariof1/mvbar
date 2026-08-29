'use client';

import { apiFetch } from './apiClient';

const PUSH_ENABLED_KEY = 'mvbar_web_push_enabled';
let registrationPromise: Promise<ServiceWorkerRegistration> | null = null;
let activeRegistration: ServiceWorkerRegistration | null = null;

export type PushNotificationStatus =
  | 'loading'
  | 'enabled'
  | 'disabled'
  | 'denied'
  | 'needs-install'
  | 'unsupported'
  | 'unconfigured'
  | 'error';

export type PushNotificationState = {
  status: PushNotificationStatus;
  publicKey: string | null;
  detail?: string;
};

function isIosDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

function browserSupportsPush() {
  return window.isSecureContext
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

function applicationServerKey(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = window.atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

async function registerPushWorker() {
  if (!registrationPromise) {
    registrationPromise = navigator.serviceWorker.register('/push-sw.js', {
      scope: '/',
      updateViaCache: 'none',
    }).then((registration) => {
      activeRegistration = registration;
      return registration;
    }).catch((error) => {
      registrationPromise = null;
      activeRegistration = null;
      throw error;
    });
  }
  return registrationPromise;
}

function subscriptionBody(subscription: PushSubscription) {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: json.keys,
  };
}

async function saveSubscription(token: string, subscription: PushSubscription) {
  await apiFetch('/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify(subscriptionBody(subscription)),
  }, token);
  window.localStorage.setItem(PUSH_ENABLED_KEY, 'true');
}

export async function preparePushNotifications(token?: string | null) {
  if (!browserSupportsPush()) return null;
  const registration = await registerPushWorker();
  if (token) {
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await saveSubscription(token, subscription);
  }
  return registration;
}

export async function inspectPushNotifications(token: string): Promise<PushNotificationState> {
  if (!window.isSecureContext) {
    return { status: 'unsupported', publicKey: null, detail: 'Notifications require HTTPS.' };
  }
  if (!browserSupportsPush()) {
    if (isIosDevice() && !isStandalone()) {
      return {
        status: 'needs-install',
        publicKey: null,
        detail: 'On iPhone or iPad, add mvbar to the Home Screen and open it from there first.',
      };
    }
    return { status: 'unsupported', publicKey: null, detail: 'This browser does not support Web Push.' };
  }

  const config = await apiFetch('/push/config', { method: 'GET' }, token) as {
    configured: boolean;
    publicKey: string | null;
  };
  if (!config.configured || !config.publicKey) return { status: 'unconfigured', publicKey: null };
  if (Notification.permission === 'denied') return { status: 'denied', publicKey: config.publicKey };

  try {
    const registration = await registerPushWorker();
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await saveSubscription(token, subscription);
      return { status: 'enabled', publicKey: config.publicKey };
    }
    window.localStorage.removeItem(PUSH_ENABLED_KEY);
    return { status: 'disabled', publicKey: config.publicKey };
  } catch (error) {
    return {
      status: 'error',
      publicKey: config.publicKey,
      detail: error instanceof Error ? error.message : 'Could not initialize notifications.',
    };
  }
}

export function enablePushNotifications(token: string, publicKey: string) {
  if (!browserSupportsPush()) return Promise.reject(new Error('Web Push is not supported on this device.'));
  if (!activeRegistration) return Promise.reject(new Error('Notification setup is still loading. Please try again.'));

  // subscribe() is deliberately invoked before awaiting anything so mobile
  // browsers see it as part of the user's button tap.
  const subscriptionPromise = activeRegistration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey),
  });
  return subscriptionPromise.then((subscription) => saveSubscription(token, subscription));
}

export async function unsubscribeCurrentPushDevice(token?: string | null) {
  if (!browserSupportsPush()) return;
  const registration = await registerPushWorker();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    window.localStorage.removeItem(PUSH_ENABLED_KEY);
    return;
  }
  if (token) {
    try {
      await apiFetch('/push/subscriptions', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }, token);
    } finally {
      await subscription.unsubscribe();
    }
  } else {
    await subscription.unsubscribe();
  }
  window.localStorage.removeItem(PUSH_ENABLED_KEY);
}

export function systemSocialNotificationsEnabled() {
  return typeof window !== 'undefined'
    && 'Notification' in window
    && Notification.permission === 'granted'
    && window.localStorage.getItem(PUSH_ENABLED_KEY) === 'true';
}

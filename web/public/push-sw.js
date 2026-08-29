/* mvbar service worker: Web Push only. It intentionally does not cache authenticated content. */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = typeof payload.title === 'string' ? payload.title : 'mvbar';
  const body = typeof payload.body === 'string' ? payload.body : 'You have new activity.';
  const tag = typeof payload.tag === 'string' ? payload.tag : 'mvbar-activity';
  const url = typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/#/social';

  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    icon: '/icon-192.png',
    badge: '/favicon-32x32.png',
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const relativeUrl = event.notification.data && typeof event.notification.data.url === 'string'
    ? event.notification.data.url
    : '/#/social';
  const targetUrl = new URL(relativeUrl, self.location.origin);
  if (targetUrl.origin !== self.location.origin) return;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.navigate(targetUrl.href);
        return client.focus();
      }
    }
    return self.clients.openWindow(targetUrl.href);
  })());
});

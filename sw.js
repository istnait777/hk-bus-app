self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Fires on iPhone lock screen even when app is closed/minimized
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {
    title: '🚌 HK Bus 1-Min Alert!',
    body: 'Your saved bus is arriving at the stop in 1 minute!'
  };

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: 'hk-bus-1m-alert',
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('./'));
});

// ══ Push event handlers (importScripts en el SW auto-generado por Workbox) ══
//
// Este archivo se inyecta en el service worker via workbox.importScripts.
// Registra los handlers de push y notificationclick. La UI del recordatorio
// del pájaro carpintero llega acá cuando el backend envía el push.
//
// Convención de payload (desde api/send-push-reminders.ts):
//   {
//     title: 'Tu sesión del pájaro carpintero',
//     body:  'test1 · ciclo 2 / 7',
//     url:   'https://shajmat.vercel.app/entrenar',
//     tag:   'wpk-<setId>',        // deduplica notifs del mismo set
//     setId: '<uuid>'              // opcional, para deep-link futuro
//   }

self.addEventListener('push', (event) => {
  let payload = { title: 'Shajmat', body: 'Tenés una sesión programada.', url: '/entrenar' }
  try {
    if (event.data) payload = { ...payload, ...event.data.json() }
  } catch (e) {
    // El payload no era JSON — usamos defaults.
  }
  const options = {
    body: payload.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || 'shajmat-generic',
    data: { url: payload.url || '/entrenar' },
    renotify: true,
    // Sin actions por simplicidad; iOS soporte de actions es inconsistente.
  }
  event.waitUntil(self.registration.showNotification(payload.title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = (event.notification.data && event.notification.data.url) || '/entrenar'
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // Si ya hay una pestaña abierta del origen, la enfocamos y navegamos.
    for (const client of clientsList) {
      const url = new URL(client.url)
      if (url.origin === self.location.origin) {
        await client.focus()
        if ('navigate' in client) {
          try { await client.navigate(targetUrl) } catch (e) { /* ignore */ }
        }
        return
      }
    }
    // Sino abrimos una nueva.
    await self.clients.openWindow(targetUrl)
  })())
})

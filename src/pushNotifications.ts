// ══ Web Push subscription (cliente) ══════════════════════════════════════════
//
// Gestiona el ciclo de vida de la suscripción web-push para el recordatorio
// del pájaro carpintero. Coordinación:
//
//   1. Chequeamos soporte (browser + service worker + Notification API).
//   2. Si el user apreta "habilitar", pedimos permission y creamos el
//      PushSubscription contra el push service del browser.
//   3. Persistimos la subscription en Supabase (tabla push_subscriptions)
//      con upsert por (user_id, endpoint) — idempotente si el user re-habilita.
//   4. Al des-habilitar, unsubscribe del browser + delete en DB.
//
// La private key del VAPID vive server-side (Vercel Function). Acá sólo
// usamos la PUBLIC key (VITE_VAPID_PUBLIC_KEY) para el applicationServerKey.

import { supabase } from './supabase'

// Convierte base64url → Uint8Array (formato que espera pushManager.subscribe).
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

// Convierte ArrayBuffer → base64url (formato que espera nuestro backend).
function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let bin = ''
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function isPushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
}

export function getPermissionState(): NotificationPermission | 'unsupported' {
  if (!isPushSupported()) return 'unsupported'
  return Notification.permission
}

// Devuelve la subscription actual del browser (si el user ya se suscribió
// antes). Útil al montar la UI para saber si mostrar "Habilitar" o "Quitar".
export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null
  const reg = await navigator.serviceWorker.ready
  return reg.pushManager.getSubscription()
}

type SubscribeResult = { ok: true } | { ok: false; error: string }

// Pide permission, crea la subscription contra el push service y la persiste
// en Supabase. Idempotente: si ya existía subscription, hace upsert.
export async function subscribeToPush(userId: string): Promise<SubscribeResult> {
  if (!isPushSupported()) return { ok: false, error: 'Tu browser no soporta notificaciones push.' }
  const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
  if (!publicKey) return { ok: false, error: 'Falta VAPID_PUBLIC_KEY en la config.' }

  // Permission
  let permission = Notification.permission
  if (permission === 'default') permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return { ok: false, error: permission === 'denied'
      ? 'Bloqueaste las notificaciones. Habilitalas desde la config del browser.'
      : 'Necesitamos tu permiso para mandar recordatorios.' }
  }

  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()

  // Si ya hay una subscription pero con distinta VAPID key (rotación), tirar y renovar.
  if (sub) {
    const currentKey = sub.options.applicationServerKey
    if (currentKey) {
      const currentB64 = arrayBufferToBase64Url(currentKey as ArrayBuffer)
      if (currentB64 !== publicKey.replace(/=+$/, '')) {
        await sub.unsubscribe()
        sub = null
      }
    }
  }

  if (!sub) {
    // pushManager.subscribe espera ArrayBufferView con ArrayBuffer (no
    // SharedArrayBuffer). Pasamos el .buffer del Uint8Array — es un
    // ArrayBuffer regular en runtime.
    const keyBytes = urlBase64ToUint8Array(publicKey)
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes.buffer as ArrayBuffer,
    })
  }

  const p256dh = sub.getKey('p256dh')
  const auth   = sub.getKey('auth')
  if (!p256dh || !auth) return { ok: false, error: 'No pudimos leer las keys de la subscription.' }

  const { error } = await supabase.from('push_subscriptions').upsert({
    user_id:    userId,
    endpoint:   sub.endpoint,
    p256dh:     arrayBufferToBase64Url(p256dh),
    auth:       arrayBufferToBase64Url(auth),
    user_agent: navigator.userAgent,
  }, { onConflict: 'user_id,endpoint' })

  if (error) return { ok: false, error: `No se pudo guardar la subscription: ${error.message}` }
  return { ok: true }
}

// Unsubscribe del browser + delete en DB.
export async function unsubscribeFromPush(userId: string): Promise<void> {
  if (!isPushSupported()) return
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (sub) {
    const endpoint = sub.endpoint
    await sub.unsubscribe()
    await supabase.from('push_subscriptions').delete()
      .eq('user_id', userId).eq('endpoint', endpoint)
  }
}

// True si el user ya se suscribió en ESTE device (browser). Otros devices
// del mismo user pueden estar suscritos independientemente.
export async function isSubscribedOnThisDevice(): Promise<boolean> {
  const sub = await getCurrentSubscription()
  return !!sub
}

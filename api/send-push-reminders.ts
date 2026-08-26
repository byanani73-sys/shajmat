// ══ Cron endpoint: send push reminders ═══════════════════════════════════════
//
// Se dispara por Vercel Cron (ver vercel.json). Por cada woodpecker_set
// activo cuyo next_session_at ≤ ahora y que no haya recibido push en las
// últimas 20 horas, manda push notification a todas las subscriptions del
// user.
//
// Payload esperado por public/push-sw.js:
//   { title, body, url, tag }
//
// Autenticación: Vercel Cron incluye el header `Authorization: Bearer <secret>`
// cuando la variable de entorno CRON_SECRET está seteada. Rechazamos requests
// sin ese header para evitar spam externo. Si CRON_SECRET no está seteada,
// dejamos abierto (dev/preview).

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import webPush from 'web-push'

// ── Setup ────────────────────────────────────────────────────────────────

const SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://vqtznfadpvqfpnkiwgak.supabase.co'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const VAPID_PUBLIC_KEY     = process.env.VAPID_PUBLIC_KEY
const VAPID_PRIVATE_KEY    = process.env.VAPID_PRIVATE_KEY
const VAPID_SUBJECT        = process.env.VAPID_SUBJECT || 'mailto:hello@shajmat.app'
const CRON_SECRET          = process.env.CRON_SECRET

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
}

// Ventana de deduplicación: si mandamos push a un set en las últimas 20h,
// no re-mandamos aunque el cron corra otra vez (por ej si el cron es diario
// pero se dispara dos veces por un retry).
const REMINDER_DEDUPE_HOURS = 20

// ── Handler ──────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Auth: Vercel Cron manda Authorization: Bearer <CRON_SECRET> automáticamente.
  if (CRON_SECRET) {
    const auth = req.headers.authorization || ''
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' })
    }
  }

  if (!SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured' })
  }
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: 'VAPID keys not configured' })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const nowIso   = new Date().toISOString()
  const cutoffIso = new Date(Date.now() - REMINDER_DEDUPE_HOURS * 3600 * 1000).toISOString()

  // Traer sets con recordatorio que ya llegó Y no recibieron push reciente.
  // last_push_sent_at null significa "nunca se envió" → siempre elegible.
  const { data: sets, error: setsErr } = await supabase
    .from('woodpecker_sets')
    .select('id, user_id, name, current_cycle, total_cycles, next_session_at, last_push_sent_at')
    .eq('status', 'active')
    .lte('next_session_at', nowIso)
    .or(`last_push_sent_at.is.null,last_push_sent_at.lt.${cutoffIso}`)

  if (setsErr) return res.status(500).json({ error: setsErr.message })
  const dueSets = sets ?? []
  if (dueSets.length === 0) return res.status(200).json({ ok: true, sent: 0, sets: 0 })

  // Traer todas las subscriptions de los users afectados en un solo query.
  const userIds = [...new Set(dueSets.map(s => s.user_id))]
  const { data: subs, error: subsErr } = await supabase
    .from('push_subscriptions')
    .select('user_id, endpoint, p256dh, auth')
    .in('user_id', userIds)

  if (subsErr) return res.status(500).json({ error: subsErr.message })
  const subsByUser = new Map<string, typeof (subs ?? [])>()
  for (const s of subs ?? []) {
    const arr = subsByUser.get(s.user_id) ?? []
    arr.push(s); subsByUser.set(s.user_id, arr)
  }

  const baseUrl = process.env.SITE_URL || 'https://shajmat.vercel.app'
  let sent = 0
  const expiredEndpoints: string[] = []

  for (const set of dueSets) {
    const userSubs = subsByUser.get(set.user_id) ?? []
    if (userSubs.length === 0) continue  // user no habilitó push

    const payload = JSON.stringify({
      title: 'Sesión programada · Pájaro Carpintero',
      body:  `${set.name} · ciclo ${set.current_cycle} / ${set.total_cycles}`,
      url:   `${baseUrl}/entrenar`,
      tag:   `wpk-${set.id}`,
      setId: set.id,
    })

    for (const sub of userSubs) {
      try {
        await webPush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 24 * 3600 },
        )
        sent += 1
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode
        // 404/410 = subscription expirada, marcar para limpieza.
        if (status === 404 || status === 410) expiredEndpoints.push(sub.endpoint)
        // Otros errores: los ignoramos (log opcional), no cortamos el batch.
        console.error(`push failed for ${sub.endpoint.slice(0, 60)}...: ${status ?? 'unknown'}`)
      }
    }

    // Marcar el set como notificado.
    await supabase.from('woodpecker_sets')
      .update({ last_push_sent_at: nowIso })
      .eq('id', set.id)
  }

  // Limpiar subscriptions expiradas (una sola llamada).
  if (expiredEndpoints.length > 0) {
    await supabase.from('push_subscriptions').delete()
      .in('endpoint', expiredEndpoints)
  }

  return res.status(200).json({
    ok: true,
    sets: dueSets.length,
    sent,
    expiredCleaned: expiredEndpoints.length,
  })
}

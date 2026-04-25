// Outbox de sesiones offline.
//
// Cuando endSess() guarda una sesión y Supabase falla (offline u otro motivo),
// la sesión se encola en IndexedDB. Este módulo reintenta subirlas cuando
// vuelve la conexión y al arrancar la app.

import { saveSession, saveSessionErrors } from './sessions'
import { getPendingSessions, removePendingSession } from './offlineDb'

let inFlight: Promise<number> | null = null

/**
 * Reintenta subir todas las sesiones pendientes. Idempotente: usa upsert con
 * id explícito así que si una sesión ya existe en el server, el upsert no
 * crea duplicados.
 *
 * Devuelve cuántas sesiones se subieron exitosamente.
 * Si una sesión falla (probablemente seguimos offline), corta y deja el resto
 * en la cola para el próximo intento.
 */
export function flushPendingSessions(): Promise<number> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0
    const pending = await getPendingSessions()
    if (pending.length === 0) return 0
    let succeeded = 0
    // Ordenar por created_at — subir las más viejas primero
    pending.sort((a, b) => a.created_at - b.created_at)
    for (const p of pending) {
      const sessionId = await saveSession(p.session)
      if (!sessionId) break  // probablemente seguimos sin red — dejar el resto encolado
      if (p.err_puzzle_ids.length > 0) {
        // Best-effort: si falla, el session principal ya quedó guardado.
        // El RLS no permite delete de session_errors, así que confiamos en
        // que el primer insert haya sido el único.
        await saveSessionErrors(sessionId, p.err_puzzle_ids)
      }
      await removePendingSession(p.local_id)
      succeeded++
    }
    return succeeded
  })().finally(() => { inFlight = null }) as Promise<number>
  return inFlight
}

/** Listener de reconexión: reintenta el outbox cuando vuelve la red. */
export function installOnlineOutboxListener() {
  if (typeof window === 'undefined') return
  window.addEventListener('online', () => { flushPendingSessions() })
}

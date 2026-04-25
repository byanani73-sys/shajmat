// Descarga de puzzles para uso offline.
//
// Fase A — descarga inicial (~5k puzzles, popularity > 85)
//   Queries en batches de 500. Se ejecuta una sola vez por usuario.
//
// Fase B — expansión (~20k puzzles totales, popularity > 70)
//   Queries en batches de 100 con pausa de 2s entre cada uno, para no
//   acaparar ancho de banda ni batería. Solo corre cuando hay conexión.

import { supabase } from './supabase'
import {
  savePuzzles, countOfflinePuzzles,
  isInitialDownloadDone, markInitialDownloadDone,
  type OfflinePuzzleRow,
} from './offlineDb'

const PHASE_A_TARGET     = 5_000
const PHASE_A_BATCH      = 500
const PHASE_A_MIN_POP    = 85

const PHASE_B_TARGET     = 20_000
const PHASE_B_BATCH      = 100
const PHASE_B_MIN_POP    = 70
const PHASE_B_PAUSE_MS   = 2_000

type Row = Omit<OfflinePuzzleRow, 'random_seed'>

let inFlight: Promise<void> | null = null

async function fetchBatch(minPopularity: number, offset: number, size: number): Promise<Row[]> {
  const { data, error } = await supabase
    .from('puzzles')
    .select('id, fen, solution, rating, rating_deviation, popularity, themes, opening_tags')
    .gt('popularity', minPopularity)
    .order('popularity', { ascending: false })
    .range(offset, offset + size - 1)
  if (error) throw error
  return (data ?? []) as Row[]
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function runPhaseA() {
  let total = await countOfflinePuzzles()
  let offset = total  // si ya tenemos algo, continuar desde ahí
  while (total < PHASE_A_TARGET) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return  // pausar; reanuda al volver
    let rows: Row[]
    try { rows = await fetchBatch(PHASE_A_MIN_POP, offset, PHASE_A_BATCH) }
    catch { return }                          // error de red o RLS — abortamos sin marcar como hecho
    if (rows.length === 0) break              // se agotó el set
    await savePuzzles(rows)
    offset += rows.length
    total = await countOfflinePuzzles()
  }
  await markInitialDownloadDone()
}

async function runPhaseB() {
  let total = await countOfflinePuzzles()
  let offset = total                          // arrancamos de donde quedó la fase A
  while (total < PHASE_B_TARGET) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    let rows: Row[]
    try { rows = await fetchBatch(PHASE_B_MIN_POP, offset, PHASE_B_BATCH) }
    catch { return }
    if (rows.length === 0) break
    await savePuzzles(rows)
    offset += rows.length
    total = await countOfflinePuzzles()
    if (total >= PHASE_B_TARGET) break
    await sleep(PHASE_B_PAUSE_MS)
  }
}

/**
 * Punto de entrada: dispara el sync en background.
 * Idempotente — múltiples llamadas reusan la misma promesa in-flight.
 * Falla silenciosamente para no romper el flujo de la app si Supabase está caído.
 */
export function runOfflineSync(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const initialDone = await isInitialDownloadDone()
      if (!initialDone) await runPhaseA()
      await runPhaseB()
    } catch (e) {
      console.warn('[offlineSync] error:', e)
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** Listener de reconexión: vuelve a disparar el sync cuando hay internet de nuevo. */
export function installOnlineSyncListener() {
  if (typeof window === 'undefined') return
  window.addEventListener('online', () => { runOfflineSync() })
}

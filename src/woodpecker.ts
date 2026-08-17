// ══ Pájaro Carpintero — data layer ═══════════════════════════════════════════
//
// Wrapper CRUD sobre las tablas woodpecker_sets / _puzzles / _attempts y la
// RPC pick_puzzles_for_set. Toda la lógica de negocio (agregados, próxima
// posición, cierre de ciclo) vive acá — las pantallas sólo consumen.
//
// Idempotencia: todas las escrituras usan id generado en cliente + upsert
// donde aplica, para poder reintentar sin duplicar (mismo patrón que
// sessions.ts).

import { supabase } from './supabase'
import type { PuzzleFilters, Puzzle } from './lichess'
import { Chess } from 'chess.js'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type SetStatus = 'active' | 'completed' | 'abandoned'
export type OrderMode = 'fixed' | 'random'

export interface WoodpeckerSet {
  id:                string
  user_id:           string
  name:              string
  size:              number
  filters:           PuzzleFilters
  order_mode:        OrderMode
  time_target_pct:   number
  total_cycles:      number
  current_cycle:     number
  status:            SetStatus
  next_session_at:   string | null
  created_at:        string
  completed_at:      string | null
}

export interface Attempt {
  id:                string
  set_id:            string
  cycle_number:      number
  puzzle_id:         string
  position:          number
  time_ms:           number
  correct:           boolean
  is_retry:          boolean
  session_group_id:  string | null
  attempted_at:      string
}

export interface CycleStats {
  cycle:               number
  total_ms:            number         // suma de time_ms de intentos no-retry
  attempts:            number         // total de intentos no-retry
  errors:              number         // cantidad de intentos incorrectos (no-retry)
  puzzles_completed:   number         // cuántas positions distintas ya se hicieron (no-retry)
  first_attempt_at:    string | null
  last_attempt_at:     string | null
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

function genId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// Shuffle determinístico (Mulberry32) — mismo seed = mismo orden. Usado en
// modo 'random' para regenerar el orden de un ciclo sin persistirlo:
// seed = hash(set_id + cycle_number).
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = arr.slice()
  let s = seed >>> 0
  const rand = () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function hashString(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// ═════════════════════════════════════════════════════════════════════════════
// Sets: CRUD
// ═════════════════════════════════════════════════════════════════════════════

export async function listSets(userId: string): Promise<WoodpeckerSet[]> {
  const { data, error } = await supabase
    .from('woodpecker_sets')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) { console.error('listSets:', error); return [] }
  return (data ?? []) as WoodpeckerSet[]
}

export async function getSet(setId: string): Promise<WoodpeckerSet | null> {
  const { data, error } = await supabase
    .from('woodpecker_sets')
    .select('*')
    .eq('id', setId)
    .maybeSingle()
  if (error) { console.error('getSet:', error); return null }
  return (data as WoodpeckerSet | null)
}

export interface CreateSetInput {
  user_id:          string
  name:             string
  size:             number
  filters:          PuzzleFilters
  order_mode:       OrderMode
  time_target_pct:  number
  total_cycles:     number
}

// Crea un set y llena su tabla de puzzles con IDs random que matcheen los
// filtros (via RPC). Si no hay puzzles suficientes, devuelve error y no
// crea nada. Todo se hace en dos pasos porque no tenemos transacción cross-
// table desde el cliente — si el segundo insert falla borramos el set.
export async function createSet(input: CreateSetInput): Promise<{ set?: WoodpeckerSet, error?: string }> {
  // 1) Pedir los N puzzles a la RPC
  const f = input.filters
  const { data: picked, error: pickErr } = await supabase.rpc('pick_puzzles_for_set', {
    p_count:            input.size,
    p_min_rating:       f.minRating ?? 400,
    p_max_rating:       f.maxRating ?? 3000,
    p_mate_themes:      f.mateThemes    && f.mateThemes.length    > 0 ? f.mateThemes    : null,
    p_mate_patterns:    f.matePatterns  && f.matePatterns.length  > 0 ? f.matePatterns  : null,
    p_tactics:          f.tactics       && f.tactics.length       > 0 ? f.tactics       : null,
    p_phases:           f.phases        && f.phases.length        > 0 ? f.phases        : null,
    p_endgame_types:    f.endgameTypes  && f.endgameTypes.length  > 0 ? f.endgameTypes  : null,
    p_lengths:          f.lengths       && f.lengths.length       > 0 ? f.lengths       : null,
    p_evaluations:      f.evaluations   && f.evaluations.length   > 0 ? f.evaluations   : null,
    p_openings_filter:  f.openingTags   && f.openingTags.length   > 0 ? f.openingTags   : null,
  })
  if (pickErr) return { error: pickErr.message }
  const puzzles = (picked as { puzzle_id: string }[]) ?? []
  if (puzzles.length === 0) return { error: 'No hay puzzles disponibles con esos filtros. Aflojá el rango o los temas.' }
  if (puzzles.length < input.size) {
    return { error: `Sólo se encontraron ${puzzles.length} puzzles y pediste ${input.size}. Aflojá los filtros o bajá el tamaño.` }
  }

  // 2) Crear el set
  const setId = genId()
  const { data: setRow, error: setErr } = await supabase
    .from('woodpecker_sets')
    .insert({
      id:               setId,
      user_id:          input.user_id,
      name:             input.name,
      size:             input.size,
      filters:          f,
      order_mode:       input.order_mode,
      time_target_pct:  input.time_target_pct,
      total_cycles:     input.total_cycles,
    })
    .select()
    .single()
  if (setErr || !setRow) return { error: setErr?.message ?? 'No se pudo crear el set' }

  // 3) Insertar los puzzles con su position
  const rows = puzzles.map((p, i) => ({ set_id: setId, position: i, puzzle_id: p.puzzle_id }))
  const { error: puzErr } = await supabase.from('woodpecker_puzzles').insert(rows)
  if (puzErr) {
    // rollback manual del set (RLS-safe, es propio)
    await supabase.from('woodpecker_sets').delete().eq('id', setId)
    return { error: `No se pudieron cargar los puzzles: ${puzErr.message}` }
  }

  return { set: setRow as WoodpeckerSet }
}

export async function updateSet(setId: string, updates: Partial<Pick<WoodpeckerSet,
  'name' | 'next_session_at' | 'status' | 'current_cycle' | 'completed_at'
>>): Promise<void> {
  const { error } = await supabase.from('woodpecker_sets').update(updates).eq('id', setId)
  if (error) console.error('updateSet:', error)
}

export async function deleteSet(setId: string): Promise<void> {
  const { error } = await supabase.from('woodpecker_sets').delete().eq('id', setId)
  if (error) console.error('deleteSet:', error)
}

// ═════════════════════════════════════════════════════════════════════════════
// Puzzles del set + orden por ciclo
// ═════════════════════════════════════════════════════════════════════════════

// Devuelve los puzzle_ids del set en orden BASE (el que se congeló al crear).
export async function getSetPuzzleIds(setId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('woodpecker_puzzles')
    .select('position, puzzle_id')
    .eq('set_id', setId)
    .order('position', { ascending: true })
  if (error) { console.error('getSetPuzzleIds:', error); return [] }
  return (data ?? []).map(r => r.puzzle_id as string)
}

// Devuelve las positions (0..size-1) en el orden en el que se juegan durante
// `cycle`. En modo 'fixed' es [0, 1, 2, ...]. En modo 'random' se calcula un
// shuffle determinístico basado en set_id + cycle para no tener que persistir
// el orden por ciclo (misma llamada devuelve siempre el mismo orden).
export function orderForCycle(set: Pick<WoodpeckerSet, 'id'|'size'|'order_mode'>, cycle: number): number[] {
  const positions = Array.from({ length: set.size }, (_, i) => i)
  if (set.order_mode === 'fixed') return positions
  const seed = hashString(`${set.id}:${cycle}`)
  return seededShuffle(positions, seed)
}

// Trae los datos completos (fen, solution, rating, themes) de un batch de
// puzzle_ids. Los devolvemos como Puzzle[] listos para consumir por el
// solving screen (mismo shape que usa el modo Storm).
export async function fetchPuzzlesByIds(ids: string[]): Promise<Map<string, Puzzle>> {
  if (ids.length === 0) return new Map()
  const { data, error } = await supabase
    .from('puzzles')
    .select('id, fen, solution, rating, themes')
    .in('id', ids)
  if (error) { console.error('fetchPuzzlesByIds:', error); return new Map() }
  const m = new Map<string, Puzzle>()
  for (const row of (data ?? [])) {
    const r = row as { id: string; fen: string; solution: string[]; rating: number; themes: string[] }
    const turn = r.fen.split(' ')[1] === 'w' ? 'white' : 'black'
    const theme = pickThemeLabel(r.themes)
    m.set(r.id, { id: r.id, fen: r.fen, solution: r.solution, rating: r.rating, turn, theme })
  }
  return m
}

// Devuelve un theme label legible para mostrar en el tag del puzzle. Sin las
// traducciones del catálogo (para no importar themes.ts acá); versión corta:
// primer theme conocido o fallback al primero raw.
function pickThemeLabel(themes: string[]): string {
  const known: Record<string, string> = {
    mateIn1: 'Mate en 1', mateIn2: 'Mate en 2', mateIn3: 'Mate en 3',
    fork: 'Horquilla', pin: 'Clavada', skewer: 'Ensarte',
    backRankMate: 'Línea trasera', sacrifice: 'Sacrificio',
    discoveredAttack: 'Ataque al descubierto', doubleCheck: 'Jaque doble',
  }
  for (const t of themes) if (known[t]) return known[t]
  return themes[0] ?? 'Táctica'
}

// ═════════════════════════════════════════════════════════════════════════════
// Attempts + progreso por ciclo
// ═════════════════════════════════════════════════════════════════════════════

export interface RecordAttemptInput {
  set_id:            string
  cycle_number:      number
  puzzle_id:         string
  position:          number
  time_ms:           number
  correct:           boolean
  is_retry?:         boolean
  session_group_id?: string
}

export async function recordAttempt(input: RecordAttemptInput): Promise<void> {
  const { error } = await supabase.from('woodpecker_attempts').insert({
    id:                genId(),
    set_id:            input.set_id,
    cycle_number:      input.cycle_number,
    puzzle_id:         input.puzzle_id,
    position:          input.position,
    time_ms:           input.time_ms,
    correct:           input.correct,
    is_retry:          input.is_retry ?? false,
    session_group_id:  input.session_group_id ?? null,
  })
  if (error) console.error('recordAttempt:', error)
}

// Trae todos los attempts del ciclo actual (no-retry) para calcular progreso
// y saber por qué posición vamos.
export async function listCycleAttempts(setId: string, cycle: number): Promise<Attempt[]> {
  const { data, error } = await supabase
    .from('woodpecker_attempts')
    .select('*')
    .eq('set_id', setId)
    .eq('cycle_number', cycle)
    .eq('is_retry', false)
    .order('attempted_at', { ascending: true })
  if (error) { console.error('listCycleAttempts:', error); return [] }
  return (data ?? []) as Attempt[]
}

// Errores del ciclo actual — TODOS los non-retry incorrectos, no importa
// en qué "sitting" pasaron. Cuando el user aprieta "Reintentar errores",
// vuelve a jugar todos los que se equivocó en el ciclo. Los intentos de
// retry (is_retry=true) no aparecen acá — no son la performance oficial.
//
// Deduplicado por position: si el user erró el mismo puzzle varias veces
// (por ej. lo intentó en dos ciclos distintos, o hubo algún bug), sólo
// aparece una vez. Se toma el primer intento errado (más viejo).
export async function listCycleErrors(setId: string, cycle: number): Promise<Attempt[]> {
  const { data } = await supabase
    .from('woodpecker_attempts')
    .select('*')
    .eq('set_id', setId)
    .eq('cycle_number', cycle)
    .eq('is_retry', false)
    .eq('correct', false)
    .order('attempted_at', { ascending: true })
  const rows = (data ?? []) as Attempt[]
  const seen = new Set<number>()
  const out: Attempt[] = []
  for (const r of rows) {
    if (seen.has(r.position)) continue
    seen.add(r.position)
    out.push(r)
  }
  return out
}

// Agregado por ciclo (para dashboard del set y comparación entre ciclos).
export async function getAllCycleStats(setId: string): Promise<CycleStats[]> {
  const { data, error } = await supabase
    .from('woodpecker_attempts')
    .select('cycle_number, time_ms, correct, position, is_retry, attempted_at')
    .eq('set_id', setId)
    .eq('is_retry', false)
    .order('cycle_number', { ascending: true })
    .order('attempted_at', { ascending: true })
  if (error) { console.error('getAllCycleStats:', error); return [] }

  const byC = new Map<number, CycleStats>()
  const seenPos = new Map<number, Set<number>>()
  for (const row of (data ?? [])) {
    const r = row as { cycle_number: number; time_ms: number; correct: boolean; position: number; is_retry: boolean; attempted_at: string }
    let c = byC.get(r.cycle_number)
    if (!c) {
      c = {
        cycle: r.cycle_number, total_ms: 0, attempts: 0, errors: 0,
        puzzles_completed: 0, first_attempt_at: r.attempted_at, last_attempt_at: r.attempted_at,
      }
      byC.set(r.cycle_number, c)
      seenPos.set(r.cycle_number, new Set())
    }
    c.total_ms  += r.time_ms
    c.attempts  += 1
    if (!r.correct) c.errors += 1
    c.last_attempt_at = r.attempted_at
    const set = seenPos.get(r.cycle_number)!
    set.add(r.position)
    c.puzzles_completed = set.size
  }
  return [...byC.values()].sort((a, b) => a.cycle - b.cycle)
}

// ═════════════════════════════════════════════════════════════════════════════
// Progreso del ciclo actual: por dónde seguimos + próximos puzzles a jugar.
// ═════════════════════════════════════════════════════════════════════════════

export interface CycleProgress {
  cycle:             number
  order:             number[]     // positions en el orden de este ciclo
  completedPositions: Set<number> // positions ya intentadas al menos 1 vez este ciclo (no-retry)
  nextPosition:      number | null  // siguiente posición a jugar (o null si el ciclo está completo)
  attempts:          Attempt[]     // todos los attempts no-retry del ciclo (para stats)
}

export async function loadCycleProgress(set: WoodpeckerSet): Promise<CycleProgress> {
  const [attempts] = await Promise.all([
    listCycleAttempts(set.id, set.current_cycle),
  ])
  const order = orderForCycle(set, set.current_cycle)
  const completed = new Set<number>()
  for (const a of attempts) completed.add(a.position)
  const nextPosition = order.find(p => !completed.has(p)) ?? null
  return { cycle: set.current_cycle, order, completedPositions: completed, nextPosition, attempts }
}

// ═════════════════════════════════════════════════════════════════════════════
// Ciclo completo → avanzar al siguiente (o cerrar el set).
// ═════════════════════════════════════════════════════════════════════════════

// Devuelve el nuevo current_cycle. Si ya se llegó al último, setea status=completed.
export async function closeCurrentCycleAndAdvance(set: WoodpeckerSet): Promise<{ nextCycle?: number, done?: boolean }> {
  if (set.current_cycle >= set.total_cycles) {
    await updateSet(set.id, { status: 'completed', completed_at: new Date().toISOString() })
    return { done: true }
  }
  const nextCycle = set.current_cycle + 1
  await updateSet(set.id, { current_cycle: nextCycle })
  return { nextCycle }
}

// ═════════════════════════════════════════════════════════════════════════════
// Helper: validar la jugada de un puzzle (misma regla que App.tsx) — la
// pongo acá para poder reusarla desde la pantalla de solving sin importar
// código de App.tsx.
// ═════════════════════════════════════════════════════════════════════════════

export function validateMoveUci(currentFen: string, userMoveUci: string, expectedUci: string): boolean {
  if (userMoveUci === expectedUci) return true
  if (userMoveUci.length === 4 && expectedUci.length === 4 && userMoveUci === expectedUci) return true
  try {
    const exp = new Chess(currentFen)
    exp.move({
      from: expectedUci.slice(0, 2),
      to:   expectedUci.slice(2, 4),
      promotion: expectedUci.length > 4 ? (expectedUci[4] as 'q'|'r'|'b'|'n') : undefined,
    })
    if (!exp.isCheckmate()) return false
    const usr = new Chess(currentFen)
    const m = usr.move({
      from: userMoveUci.slice(0, 2),
      to:   userMoveUci.slice(2, 4),
      promotion: (userMoveUci.length > 4 ? userMoveUci[4] : 'q') as 'q'|'r'|'b'|'n',
    })
    return !!m && usr.isCheckmate()
  } catch { return false }
}

// Formato de cronómetro con segundos siempre — mm:ss o hh:mm:ss.
// Ideal para el sidebar del pájaro carpintero donde el usuario mira el
// tiempo correr en vivo y necesita ver el segundero moverse.
export function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  return `${m}:${pad(s)}`
}

// Formato "humano" corto para labels donde no importa el segundero — usado
// en el overview y la lista de sets. Ej: "1h 23min", "45min", "45s".
export function fmtDurationHuman(ms: number): string {
  if (ms < 0) ms = 0
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return m > 0 ? `${h}h ${m}min` : `${h}h`
  if (m > 0) return `${m}min`
  return `${s}s`
}

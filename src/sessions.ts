import { supabase } from './supabase'

// ── Tipos ─────────────────────────────────────────────────────────────────
export type Mode = 'storm' | 'streak' | 'practice'

export interface SessionRecord {
  id?:          string
  user_id:      string
  mode:         Mode
  minutes:      number
  themes:       string[]
  opening_tags: string[]
  min_rating?:  number
  max_rating?:  number
  score_ok:     number
  score_err:    number
  puzzles_seen: string[]
  started_at:   string
  ended_at?:    string
}

export interface BestScores {
  today:   number | null
  week:    number | null
  month:   number | null
  allTime: number | null
}

// ── Guardar sesión ─────────────────────────────────────────────────────────
//
// Genera un id local con crypto.randomUUID() y hace upsert para que la
// operación sea idempotente. Esto permite reintentar el guardado desde el
// outbox sin riesgo de crear sesiones duplicadas.
function genId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export async function saveSession(session: SessionRecord): Promise<string | null> {
  const id = session.id ?? genId()
  const payload = { ...session, id, ended_at: session.ended_at ?? new Date().toISOString() }
  const { error } = await supabase
    .from('sessions')
    .upsert(payload, { onConflict: 'id' })
  if (error) { console.error('Error guardando sesión:', error); return null }
  return id
}

// ── Guardar errores de la sesión ───────────────────────────────────────────
export async function saveSessionErrors(sessionId: string, puzzleIds: string[]) {
  if (puzzleIds.length === 0) return
  const rows = puzzleIds.map(pid => ({ session_id: sessionId, puzzle_id: pid }))
  const { error } = await supabase.from('session_errors').insert(rows)
  if (error) console.error('Error guardando errores:', error)
}

// ── Mejores puntajes (por modo) ────────────────────────────────────────────
export async function getBestScores(userId: string, mode: 'storm' | 'streak' = 'storm'): Promise<BestScores> {
  const now   = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const week  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000).toISOString()
  const month = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const query = (from: string) =>
    supabase
      .from('sessions')
      .select('score_ok')
      .eq('user_id', userId)
      .eq('mode', mode)
      .gte('started_at', from)
      .order('score_ok', { ascending: false })
      .limit(1)
      .single()

  const [todayRes, weekRes, monthRes, allRes] = await Promise.all([
    query(today),
    query(week),
    query(month),
    supabase
      .from('sessions')
      .select('score_ok')
      .eq('user_id', userId)
      .eq('mode', mode)
      .order('score_ok', { ascending: false })
      .limit(1)
      .single(),
  ])

  return {
    today:   todayRes.data?.score_ok   ?? null,
    week:    weekRes.data?.score_ok    ?? null,
    month:   monthRes.data?.score_ok   ?? null,
    allTime: allRes.data?.score_ok     ?? null,
  }
}

// ── Historial reciente (para gráficos futuros) ─────────────────────────────
export async function getRecentSessions(userId: string, limit = 20) {
  const { data } = await supabase
    .from('sessions')
    .select('score_ok, score_err, started_at, minutes, themes')
    .eq('user_id', userId)
    .eq('mode', 'storm')
    .order('started_at', { ascending: false })
    .limit(limit)
  return data ?? []
}

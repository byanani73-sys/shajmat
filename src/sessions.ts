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

// ═════════════════════════════════════════════════════════════════════════
// Dashboard queries
// ═════════════════════════════════════════════════════════════════════════

export type Timeframe = '1m' | '3m' | '6m' | '1y' | 'all'

const TIMEFRAME_DAYS: Record<Exclude<Timeframe,'all'>, number> = { '1m':30, '3m':90, '6m':180, '1y':365 }

export function timeframeStart(tf: Timeframe): string | null {
  if (tf === 'all') return null
  const days = TIMEFRAME_DAYS[tf]
  return new Date(Date.now() - days * 24*60*60*1000).toISOString()
}

// ── Resumen general (sesiones, puzzles, precisión %) ───────────────────────
export interface DashboardSummary { sessions: number; puzzles: number; accuracy: number }

export async function getDashboardSummary(userId: string, tf: Timeframe): Promise<DashboardSummary> {
  let q = supabase.from('sessions').select('score_ok, score_err').eq('user_id', userId)
  const start = timeframeStart(tf)
  if (start) q = q.gte('started_at', start)
  const { data } = await q
  const rows = data ?? []
  const sessions = rows.length
  const puzzles  = rows.reduce((a, r) => a + (r.score_ok ?? 0) + (r.score_err ?? 0), 0)
  const correct  = rows.reduce((a, r) => a + (r.score_ok ?? 0), 0)
  const accuracy = puzzles > 0 ? (correct / puzzles) * 100 : 0
  return { sessions, puzzles, accuracy }
}

// ── Actividad por día (calendario heatmap) ─────────────────────────────────
export interface ActivityDay { date: string; sessions: number }

export async function getDashboardActivity(userId: string, tf: Timeframe): Promise<Map<string, number>> {
  let q = supabase.from('sessions').select('started_at').eq('user_id', userId)
  const start = timeframeStart(tf)
  if (start) q = q.gte('started_at', start)
  const { data } = await q
  const counts = new Map<string, number>()
  for (const r of (data ?? [])) {
    const day = (r.started_at as string).split('T')[0]
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  return counts
}

// ── Racha actual (consecutiva desde hoy) y mejor histórica ─────────────────
export interface StreakInfo { current: number; longest: number; lastSessionAt: string | null }

export async function getDashboardStreak(userId: string): Promise<StreakInfo> {
  const { data } = await supabase
    .from('sessions').select('started_at').eq('user_id', userId)
    .order('started_at', { ascending: true })
  if (!data || data.length === 0) return { current: 0, longest: 0, lastSessionAt: null }

  const days = new Set<string>()
  for (const r of data) days.add((r.started_at as string).split('T')[0])
  const sorted = [...days].sort()

  // Mejor racha: pasada de mayor secuencia consecutiva
  let longest = 0, run = 0
  let prev: number | null = null
  for (const dStr of sorted) {
    const t = new Date(dStr + 'T00:00:00Z').getTime()
    if (prev !== null) {
      const diff = Math.round((t - prev) / (24*60*60*1000))
      run = diff === 1 ? run + 1 : 1
    } else { run = 1 }
    if (run > longest) longest = run
    prev = t
  }

  // Racha actual: cuántos días consecutivos terminando HOY (UTC)
  let current = 0
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  for (let off = 0; off < 365; off++) {
    const d = new Date(today.getTime() - off * 24*60*60*1000)
    const dStr = d.toISOString().split('T')[0]
    if (days.has(dStr)) current++
    else break
  }
  const lastSessionAt = data[data.length - 1].started_at as string
  return { current, longest, lastSessionAt }
}

// ── Mejor score por semana (gráfico de barras) ─────────────────────────────
export interface WeeklyScore { week: string; best_score: number; count: number }

export async function getWeeklyScores(userId: string, mode: Mode, tf: Timeframe): Promise<WeeklyScore[]> {
  let q = supabase.from('sessions').select('started_at, score_ok')
    .eq('user_id', userId).eq('mode', mode)
  const start = timeframeStart(tf)
  if (start) q = q.gte('started_at', start)
  const { data } = await q.order('started_at')

  const weeks = new Map<string, { best: number; count: number }>()
  for (const r of (data ?? [])) {
    const d = new Date(r.started_at as string)
    const day = d.getUTCDay()
    const diff = day === 0 ? -6 : 1 - day
    const monday = new Date(d.getTime() + diff * 24*60*60*1000)
    monday.setUTCHours(0, 0, 0, 0)
    const wk = monday.toISOString().split('T')[0]
    const w = weeks.get(wk) ?? { best: 0, count: 0 }
    if ((r.score_ok ?? 0) > w.best) w.best = r.score_ok ?? 0
    w.count++
    weeks.set(wk, w)
  }
  return [...weeks.entries()]
    .map(([week, w]) => ({ week, best_score: w.best, count: w.count }))
    .sort((a, b) => a.week.localeCompare(b.week))
}

// ── Stats por tema (fortalezas / a mejorar) — vía RPC ──────────────────────
export interface ThemeStats { theme: string; total: number; errors: number; accuracy: number }

export async function getThemeStats(userId: string, tf: Timeframe): Promise<ThemeStats[]> {
  const since = timeframeStart(tf)
  const { data, error } = await supabase.rpc('dashboard_theme_stats', { p_user_id: userId, p_since: since })
  if (error) { console.error('theme stats:', error); return [] }
  return (data ?? []).map((r: { theme: string; total: number; errors: number }) => ({
    theme:    r.theme,
    total:    r.total,
    errors:   r.errors,
    accuracy: r.total > 0 ? ((r.total - r.errors) / r.total) * 100 : 0,
  }))
}

// ── Mejores scores all-time por modo ──────────────────────────────────────
export interface AllTimeBest { mode: Mode; best_score: number; best_date: string | null }

export async function getAllTimeBests(userId: string): Promise<AllTimeBest[]> {
  const modes: Mode[] = ['storm', 'streak', 'practice']
  const results: AllTimeBest[] = []
  for (const m of modes) {
    const { data } = await supabase
      .from('sessions').select('score_ok, ended_at')
      .eq('user_id', userId).eq('mode', m)
      .order('score_ok', { ascending: false }).order('ended_at', { ascending: false })
      .limit(1).maybeSingle()
    results.push({
      mode: m,
      best_score: (data?.score_ok as number) ?? 0,
      best_date:  (data?.ended_at as string) ?? null,
    })
  }
  return results
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

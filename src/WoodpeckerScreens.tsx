// ══ Pájaro Carpintero — pantallas ═══════════════════════════════════════════
//
// Router interno + 5 pantallas de la sección "Pájaro Carpintero":
//   locked → guest ve un CTA de login
//   list   → lista de sets del usuario, con opción de crear nuevo
//   create → form: nombre, tamaño, filtros, orden, target %
//   overview → dashboard del set (progreso ciclo actual, historial, continuar)
//   solving  → resolver puzzles del ciclo (sin timer que corte)
//   done     → resumen del ciclo terminado
//
// Todas las escrituras van a Supabase via el data layer woodpecker.ts. Este
// archivo NO importa de App.tsx salvo el ThemeModal (para el selector de
// filtros al crear un set) — el resto está autocontenido con los tokens de
// design.ts, ChessBoard, PromotionSelector y StockfishEngine.

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Chess } from 'chess.js'
import type { Key } from 'chessground/types'
import type { DrawShape } from 'chessground/draw'
import { ChessBoard } from './ChessBoard'
import { PromotionSelector, type PromoPiece } from './PromotionSelector'
import { StockfishEngine, formatEval, evalToBarFraction, type EvalInfo } from './stockfish'
import { C, mono, cinzel, useIsDesktop } from './design'
import type { AuthUser } from './auth'
import { signInWithGoogle } from './auth'
import { playCorrect, playWrong, playMove } from './sounds'
import type { PuzzleFilters, Puzzle } from './lichess'
import { ThemeModal } from './App'
import { THEME_GROUPS, ALL_OPENINGS, buildFiltersFromSelection } from './themes'
import {
  listSets, getSet, createSet, updateSet,
  getSetPuzzleIds, fetchPuzzlesByIds,
  recordAttempt, loadCycleProgress, getAllCycleStats,
  listCycleErrors,
  closeCurrentCycleAndAdvance, validateMoveUci, fmtDuration, fmtDurationHuman,
  type WoodpeckerSet, type CycleProgress, type CycleStats, type OrderMode,
} from './woodpecker'

// ─── Router interno ──────────────────────────────────────────────────────────
// La sección del pájaro carpintero es multi-pantalla. Mantengo el estado de
// navegación local acá y expongo un solo componente al padre.

type Screen =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'overview', setId: string }
  | { kind: 'solving',  setId: string, retryOnly?: boolean }
  | { kind: 'done',     setId: string, cycleClosed: number }

interface Props {
  user:      AuthUser | null
  isGuest:   boolean
  selectedThemes:   string[]
  setSelectedThemes:(s: string[]) => void
  selectedOpenings: string[]
  setSelectedOpenings:(s: string[]) => void
  minRating: number
  maxRating: number
  setRatingRange:(lo:number, hi:number) => void
}

export function WoodpeckerSection(props: Props) {
  const [screen, setScreen] = useState<Screen>({ kind: 'list' })

  // Guests: pantalla bloqueada
  if (!props.user || props.isGuest) return <LockedScreen />

  const goList     = () => setScreen({ kind: 'list' })
  const goCreate   = () => setScreen({ kind: 'create' })
  const goOverview = (setId: string) => setScreen({ kind: 'overview', setId })
  const goSolving  = (setId: string, retryOnly = false) => setScreen({ kind: 'solving', setId, retryOnly })
  const goDone     = (setId: string, cycleClosed: number) => setScreen({ kind: 'done', setId, cycleClosed })

  switch (screen.kind) {
    case 'list':
      return <ListScreen user={props.user} onCreate={goCreate} onOpen={goOverview} />
    case 'create':
      return <CreateScreen
        user={props.user}
        selectedThemes={props.selectedThemes}
        setSelectedThemes={props.setSelectedThemes}
        selectedOpenings={props.selectedOpenings}
        setSelectedOpenings={props.setSelectedOpenings}
        minRating={props.minRating}
        maxRating={props.maxRating}
        setRatingRange={props.setRatingRange}
        onCreated={(setId) => goOverview(setId)}
        onCancel={goList}
      />
    case 'overview':
      return <OverviewScreen
        setId={screen.setId}
        onBack={goList}
        onStart={() => goSolving(screen.setId)}
        onRetry={() => goSolving(screen.setId, true)}
      />
    case 'solving':
      return <SolvingScreen
        setId={screen.setId}
        retryOnly={!!screen.retryOnly}
        onExit={() => goOverview(screen.setId)}
        onCycleDone={(cycle) => goDone(screen.setId, cycle)}
      />
    case 'done':
      return <CycleDoneScreen setId={screen.setId} cycleClosed={screen.cycleClosed} onOverview={() => goOverview(screen.setId)} />
  }
}

// ══ 1. LockedScreen — guest ve login CTA ═════════════════════════════════════

function LockedScreen() {
  const [signing, setSigning] = useState(false)
  const handleGoogle = async () => {
    setSigning(true)
    try { await signInWithGoogle() }
    catch { setSigning(false) }
  }
  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', alignItems:'center', justifyContent:'center', padding:24, fontFamily:"'DM Sans',system-ui,sans-serif" }}>
      <div style={{ maxWidth:420, textAlign:'center', display:'flex', flexDirection:'column', alignItems:'center', gap:20 }}>
        <div style={{ ...cinzel, fontSize:22, fontWeight:700, letterSpacing:3, color:C.text }}>PÁJARO CARPINTERO</div>
        <div style={{ fontSize:14, color:C.muted, lineHeight:1.6 }}>
          Este módulo entrena tu reconocimiento de patrones repitiendo un set fijo de puzzles en ciclos cada vez más rápidos.
          <br /><br />
          Como te lleva semanas y necesitamos guardar tu progreso, hay que <strong style={{ color:C.text }}>iniciar sesión</strong> para usarlo.
        </div>
        <button onClick={handleGoogle} disabled={signing}
          style={{ padding:'12px 22px', borderRadius:10, background:C.amber, border:'none', color:C.bg, fontSize:14, fontWeight:700, cursor:'pointer', opacity: signing ? 0.6 : 1 }}>
          {signing ? 'Redirigiendo...' : 'Iniciar sesión con Google'}
        </button>
      </div>
    </div>
  )
}

// ══ 2. ListScreen — lista de sets del usuario ═══════════════════════════════

function ListScreen({ user, onCreate, onOpen }: {
  user: AuthUser
  onCreate: () => void
  onOpen: (setId: string) => void
}) {
  const desktop = useIsDesktop()
  const [sets,    setSets]    = useState<WoodpeckerSet[] | null>(null)
  const [stats,   setStats]   = useState<Record<string, CycleStats[]>>({})

  useEffect(() => {
    let alive = true
    listSets(user.id).then(async (rows) => {
      if (!alive) return
      setSets(rows)
      // stats de cada set en paralelo (para mostrar ciclo actual y último tiempo)
      const entries = await Promise.all(rows.map(async s => [s.id, await getAllCycleStats(s.id)] as const))
      if (alive) setStats(Object.fromEntries(entries))
    })
    return () => { alive = false }
  }, [user.id])

  const [showInfo, setShowInfo] = useState(false)

  return (
    <div style={{ minHeight:'100vh', background:C.bg, padding: desktop ? '32px 20px 60px' : '24px 16px 60px', fontFamily:"'DM Sans',system-ui,sans-serif" }}>
      <div style={{ maxWidth:760, margin:'0 auto' }}>
        {/* Header: desktop = título + botón en una fila. Mobile = stack vertical
            para que el título entre en una línea y el botón vaya full-width abajo. */}
        <div style={{
          display:'flex',
          alignItems: desktop ? 'baseline' : 'stretch',
          justifyContent:'space-between',
          marginBottom:12, gap:12,
          flexDirection: desktop ? 'row' : 'column',
        }}>
          <div style={{ display:'flex', alignItems:'baseline', gap:10 }}>
            <div style={{ ...cinzel, fontSize: desktop ? 22 : 18, fontWeight:700, letterSpacing: desktop ? 3 : 2, color:C.text }}>PÁJARO CARPINTERO</div>
            <button onClick={() => setShowInfo(true)} title="¿Qué es y para qué sirve?"
              style={{
                width:22, height:22, borderRadius:'50%',
                border:`1px solid ${C.muted}`, color:C.muted, background:'transparent',
                display:'inline-flex', alignItems:'center', justifyContent:'center',
                fontSize:12, fontFamily:'serif', fontStyle:'italic', fontWeight:700,
                cursor:'pointer', flexShrink:0, alignSelf:'center',
              }}>
              i
            </button>
          </div>
          <button onClick={onCreate}
            style={{
              padding:'10px 18px', borderRadius:10, background:C.amber, border:'none',
              color:C.bg, fontSize:13, fontWeight:700, cursor:'pointer',
              width: desktop ? undefined : '100%',
              fontFamily:"'DM Sans',sans-serif",
            }}>
            + Nuevo set
          </button>
        </div>
        <div style={{ ...mono, fontSize:10, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginBottom:20 }}>Tus sets de entrenamiento</div>
        {showInfo && <MethodInfoModal onClose={() => setShowInfo(false)} />}

        {sets === null && <div style={{ ...mono, fontSize:11, color:C.muted, textAlign:'center', padding:40 }}>Cargando...</div>}

        {sets !== null && sets.length === 0 && (
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding:'40px 24px', textAlign:'center' }}>
            <div style={{ fontSize:14, color:C.text, marginBottom:8 }}>Aún no tenés ningún set</div>
            <div style={{ fontSize:12, color:C.muted, lineHeight:1.6, marginBottom:20 }}>
              Un set es una colección fija de puzzles que vas a repetir en 7 ciclos, cada vez más rápido.
              <br />Empezá con un set chico (60 – 150 puzzles) para que entre en una sesión de 30 – 60 minutos.
            </div>
            <button onClick={onCreate}
              style={{ padding:'12px 22px', borderRadius:10, background:C.amber, border:'none', color:C.bg, fontSize:13, fontWeight:700, cursor:'pointer' }}>
              Crear mi primer set
            </button>
          </div>
        )}

        {sets && sets.length > 0 && (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {sets.map(s => (
              <SetCard key={s.id} set={s} stats={stats[s.id] ?? []} onOpen={() => onOpen(s.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SetCard({ set, stats, onOpen }: { set: WoodpeckerSet; stats: CycleStats[]; onOpen: () => void }) {
  const prev = stats.find(c => c.cycle === set.current_cycle - 1)
  const current = stats.find(c => c.cycle === set.current_cycle)
  const targetMs = prev ? Math.round(prev.total_ms * (set.time_target_pct / 100)) : null
  const dueBadge = set.next_session_at && new Date(set.next_session_at) <= new Date()

  return (
    <button onClick={onOpen}
      style={{
        display:'block', textAlign:'left', width:'100%', cursor:'pointer',
        background:C.surface, border:`1px solid ${dueBadge ? C.amber : C.border}`,
        borderRadius:12, padding:'16px 18px', color:C.text, fontFamily:"'DM Sans',sans-serif",
      }}>
      <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:8 }}>
        <div style={{ fontSize:15, fontWeight:600 }}>{set.name}</div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          {set.status === 'completed' && <span style={{ ...mono, fontSize:9, background:C.correctBg, color:C.correct, padding:'2px 8px', borderRadius:20, border:`1px solid ${C.correct}30`, letterSpacing:1, textTransform:'uppercase' }}>Completado</span>}
          {set.status === 'abandoned' && <span style={{ ...mono, fontSize:9, background:C.surface2, color:C.muted, padding:'2px 8px', borderRadius:20, border:`1px solid ${C.border}`, letterSpacing:1, textTransform:'uppercase' }}>Abandonado</span>}
          {set.status === 'active' && (
            <span style={{ ...mono, fontSize:10, color:C.amber }}>ciclo {set.current_cycle} / {set.total_cycles}</span>
          )}
        </div>
      </div>
      <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>
        {set.size} puzzles · rating {set.filters.minRating ?? 400}–{set.filters.maxRating ?? 3000}
        {set.order_mode === 'random' && ' · orden aleatorio'}
      </div>
      {set.status === 'active' && (
        <div style={{ display:'flex', flexWrap:'wrap', gap:10, marginTop:6, fontSize:11, color:C.muted }}>
          {current && current.attempts > 0 && (
            <span>
              <span style={{ color:C.text, fontWeight:600 }}>{current.puzzles_completed}</span>
              /{set.size} este ciclo · {fmtDurationHuman(current.total_ms)}
              {targetMs && <> · meta <span style={{ color:C.amber }}>{fmtDurationHuman(targetMs)}</span></>}
            </span>
          )}
          {prev && (!current || current.attempts === 0) && (
            <span>Ciclo anterior: {fmtDurationHuman(prev.total_ms)} · {prev.errors} err</span>
          )}
          {!current && !prev && <span>Aún sin intentos</span>}
          {dueBadge && <span style={{ color:C.amber }}>· sesión programada para hoy</span>}
        </div>
      )}
    </button>
  )
}

// ══ 3. CreateScreen — form ═════════════════════════════════════════════════

const SIZE_PRESETS = [60, 100, 150, 300, 500]

function CreateScreen({
  user,
  selectedThemes, setSelectedThemes,
  selectedOpenings, setSelectedOpenings,
  minRating, maxRating, setRatingRange,
  onCreated, onCancel,
}: {
  user: AuthUser
  selectedThemes: string[]; setSelectedThemes: (s: string[]) => void
  selectedOpenings: string[]; setSelectedOpenings: (s: string[]) => void
  minRating: number; maxRating: number
  setRatingRange: (lo: number, hi: number) => void
  onCreated: (setId: string) => void
  onCancel: () => void
}) {
  const [size,        setSize]        = useState(100)
  const [orderMode,   setOrderMode]   = useState<OrderMode>('fixed')
  const [targetPct,   setTargetPct]   = useState(50)
  const [totalCycles, setTotalCycles] = useState(7)
  const [name,        setName]        = useState('')
  const [showThemes,  setShowThemes]  = useState(false)
  const [creating,    setCreating]    = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  // Auto-generar nombre si el user no puso nada
  const autoName = useMemo(() => {
    const parts: string[] = []
    if (selectedThemes.length === 1) {
      const label = THEME_GROUPS.flatMap(g => g.themes).find(t => t.id === selectedThemes[0])?.label
      if (label) parts.push(label)
    } else if (selectedThemes.length > 1) {
      parts.push(`${selectedThemes.length} temas`)
    }
    if (selectedOpenings.length === 1) {
      const label = ALL_OPENINGS.find(o => o.id === selectedOpenings[0])?.label
      if (label) parts.push(label)
    }
    parts.push(`${minRating}–${maxRating}`)
    parts.push(`${size} puzzles`)
    return parts.join(' · ')
  }, [selectedThemes, selectedOpenings, minRating, maxRating, size])

  const handleCreate = async () => {
    setCreating(true)
    setError(null)
    const groups = buildFiltersFromSelection(selectedThemes, selectedOpenings)
    const filters: PuzzleFilters = { ...groups, minRating, maxRating }
    const { set, error } = await createSet({
      user_id:         user.id,
      name:            name.trim() || autoName,
      size,
      filters,
      order_mode:      orderMode,
      time_target_pct: targetPct,
      total_cycles:    totalCycles,
    })
    if (error) { setError(error); setCreating(false); return }
    if (set) onCreated(set.id)
  }

  return (
    <div style={{ minHeight:'100vh', background:C.bg, padding:'32px 20px 60px', fontFamily:"'DM Sans',system-ui,sans-serif" }}>
      <div style={{ maxWidth:520, margin:'0 auto', display:'flex', flexDirection:'column', gap:16 }}>
        <button onClick={onCancel}
          style={{ ...mono, fontSize:10, letterSpacing:2, textTransform:'uppercase', color:C.muted, cursor:'pointer', background:'none', border:'none', padding:0, textAlign:'left', marginBottom:8 }}>
          ← Volver a la lista
        </button>
        <div>
          <div style={{ ...cinzel, fontSize:20, fontWeight:700, letterSpacing:2, color:C.text }}>NUEVO SET</div>
          <div style={{ ...mono, fontSize:10, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginTop:4 }}>Fijás filtros y tamaño una sola vez</div>
        </div>

        {/* Nombre */}
        <FormRow label="Nombre del set (opcional)">
          <input type="text" value={name} onChange={e => setName(e.target.value)}
            placeholder={autoName}
            style={{ width:'100%', padding:'10px 12px', background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, fontSize:13, fontFamily:'inherit' }} />
        </FormRow>

        {/* Tamaño */}
        <FormRow label="Cantidad de puzzles">
          <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:6 }}>
            {SIZE_PRESETS.map(n => (
              <button key={n} onClick={() => setSize(n)}
                style={{
                  padding:'10px 0', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, fontFamily:'inherit',
                  background: size === n ? C.amberBg : C.surface,
                  border: `1px solid ${size === n ? C.borderAm : C.border}`,
                  color: size === n ? C.amber : C.muted,
                }}>
                {n}
              </button>
            ))}
          </div>
          <div style={{ fontSize:11, color:C.muted, marginTop:6 }}>
            {size === 60 && '~30 min por sesión'}
            {size === 100 && '~45 min por sesión'}
            {size === 150 && '~60 min por sesión'}
            {size === 300 && '2 – 3 sesiones por ciclo'}
            {size === 500 && '3 – 5 sesiones por ciclo'}
          </div>
        </FormRow>

        {/* Filtros: rating + temas (reutilizamos ThemeModal de App.tsx) */}
        <FormRow label="Rango de rating">
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <input type="number" value={minRating} min={400} max={3000}
              onChange={e => setRatingRange(Math.max(400, Math.min(parseInt(e.target.value) || 400, maxRating - 100)), maxRating)}
              style={{ width:90, padding:'8px 10px', background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, fontSize:13, fontFamily:'inherit' }} />
            <span style={{ color:C.muted, fontSize:12 }}>a</span>
            <input type="number" value={maxRating} min={500} max={3000}
              onChange={e => setRatingRange(minRating, Math.min(3000, Math.max(parseInt(e.target.value) || 3000, minRating + 100)))}
              style={{ width:90, padding:'8px 10px', background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, fontSize:13, fontFamily:'inherit' }} />
          </div>
        </FormRow>

        <FormRow label="Temas y aperturas">
          <button onClick={() => setShowThemes(true)}
            style={{ width:'100%', padding:'10px 14px', background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, color: (selectedThemes.length + selectedOpenings.length > 0) ? C.amber : C.muted, fontSize:13, fontFamily:'inherit', cursor:'pointer', textAlign:'left' }}>
            {selectedThemes.length + selectedOpenings.length === 0
              ? 'Todos los puzzles'
              : `${selectedThemes.length} temas · ${selectedOpenings.length} aperturas`}
            <span style={{ float:'right' }}>›</span>
          </button>
        </FormRow>

        {/* Orden */}
        <FormRow label="Orden de los puzzles">
          <div style={{ display:'flex', gap:6 }}>
            {(['fixed','random'] as OrderMode[]).map(m => (
              <button key={m} onClick={() => setOrderMode(m)}
                style={{
                  flex:1, padding:'10px 0', borderRadius:8, cursor:'pointer', fontSize:12, fontWeight:600, fontFamily:'inherit',
                  background: orderMode === m ? C.amberBg : C.surface,
                  border: `1px solid ${orderMode === m ? C.borderAm : C.border}`,
                  color: orderMode === m ? C.amber : C.muted,
                }}>
                {m === 'fixed' ? 'Mismo orden' : 'Aleatorio por ciclo'}
              </button>
            ))}
          </div>
          <div style={{ fontSize:11, color:C.muted, marginTop:6 }}>
            {orderMode === 'fixed'
              ? 'Los puzzles aparecen siempre en el mismo orden. Reconocimiento máximo.'
              : 'Cada ciclo se mezcla. Evita saber "qué viene después".'}
          </div>
        </FormRow>

        {/* Ciclos + target */}
        <FormRow label={`Ciclos: ${totalCycles}`}>
          <input type="range" min={3} max={12} value={totalCycles} onChange={e => setTotalCycles(parseInt(e.target.value))}
            style={{ width:'100%' }} />
        </FormRow>

        <FormRow label={`Tiempo objetivo del ciclo N+1: ${targetPct}% del ciclo anterior`}>
          <input type="range" min={30} max={70} step={5} value={targetPct} onChange={e => setTargetPct(parseInt(e.target.value))}
            style={{ width:'100%' }} />
        </FormRow>

        {error && (
          <div style={{ padding:'10px 14px', background:C.redBg, border:`1px solid ${C.red}30`, borderRadius:8, fontSize:12, color:C.red }}>
            {error}
          </div>
        )}

        <div style={{ display:'flex', gap:8, marginTop:8 }}>
          <button onClick={onCancel} disabled={creating}
            style={{ flex:1, padding:'12px', borderRadius:10, background:C.surface, border:`1px solid ${C.border}`, color:C.muted, fontSize:13, fontWeight:500, fontFamily:'inherit', cursor: creating ? 'not-allowed' : 'pointer' }}>
            Cancelar
          </button>
          <button onClick={handleCreate} disabled={creating}
            style={{ flex:2, padding:'12px', borderRadius:10, background:C.amber, border:'none', color:C.bg, fontSize:14, fontWeight:700, fontFamily:'inherit', cursor: creating ? 'not-allowed' : 'pointer', opacity: creating ? 0.6 : 1 }}>
            {creating ? 'Armando el set...' : `Crear set de ${size} puzzles`}
          </button>
        </div>
      </div>

      {showThemes && (
        <ThemeModal
          selectedThemes={selectedThemes} setSelectedThemes={setSelectedThemes}
          selectedOpenings={selectedOpenings} setSelectedOpenings={setSelectedOpenings}
          onClose={() => setShowThemes(false)}
        />
      )}
    </div>
  )
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
      <label style={{ ...mono, fontSize:10, letterSpacing:2, textTransform:'uppercase', color:C.muted }}>{label}</label>
      {children}
    </div>
  )
}

// ══ 4. OverviewScreen — dashboard del set ═══════════════════════════════════

function OverviewScreen({ setId, onBack, onStart, onRetry }: {
  setId: string
  onBack: () => void
  onStart: () => void
  onRetry: () => void
}) {
  const [set,      setSet]      = useState<WoodpeckerSet | null>(null)
  const [progress, setProgress] = useState<CycleProgress | null>(null)
  const [stats,    setStats]    = useState<CycleStats[]>([])
  const [lastSessionErrors, setLastSessionErrors] = useState<number>(0)
  const [confirmAbandon, setConfirmAbandon] = useState(false)
  const [confirmCloseCycle, setConfirmCloseCycle] = useState(false)

  const reload = useCallback(async () => {
    const s = await getSet(setId)
    if (!s) return
    setSet(s)
    const [p, cs, errs] = await Promise.all([
      loadCycleProgress(s),
      getAllCycleStats(setId),
      listCycleErrors(setId, s.current_cycle),
    ])
    setProgress(p)
    setStats(cs)
    setLastSessionErrors(errs.length)
  }, [setId])

  useEffect(() => { reload() }, [reload])

  const doAbandonSet = async () => {
    await updateSet(setId, { status: 'abandoned' })
    onBack()
  }

  const doCloseCycle = async () => {
    if (!set) return
    // Reutiliza la misma lógica que usa el flujo normal al terminar todos los
    // puzzles del ciclo. Si es el último ciclo, marca el set como completed.
    // Los attempts realizados quedan (aparecen en el historial de ciclos).
    await closeCurrentCycleAndAdvance(set)
    setConfirmCloseCycle(false)
    reload()
  }

  if (!set || !progress) {
    return (
      <div style={{ minHeight:'100vh', background:C.bg, display:'flex', alignItems:'center', justifyContent:'center', color:C.muted, ...mono, fontSize:12 }}>
        Cargando...
      </div>
    )
  }

  const currentStats = stats.find(c => c.cycle === set.current_cycle)
  const prevStats    = stats.find(c => c.cycle === set.current_cycle - 1)
  const targetMs     = prevStats ? Math.round(prevStats.total_ms * (set.time_target_pct / 100)) : null
  const done         = progress.nextPosition === null
  const doneCount    = progress.completedPositions.size

  return (
    <div style={{ minHeight:'100vh', background:C.bg, padding:'28px 20px 60px', fontFamily:"'DM Sans',system-ui,sans-serif" }}>
      <div style={{ maxWidth:640, margin:'0 auto', display:'flex', flexDirection:'column', gap:16 }}>
        <button onClick={onBack}
          style={{ ...mono, fontSize:10, letterSpacing:2, textTransform:'uppercase', color:C.muted, cursor:'pointer', background:'none', border:'none', padding:0, textAlign:'left' }}>
          ← Todos mis sets
        </button>

        <div>
          <div style={{ fontSize:18, fontWeight:700, color:C.text, marginBottom:4 }}>{set.name}</div>
          <div style={{ fontSize:12, color:C.muted }}>
            {set.size} puzzles · {set.filters.minRating ?? 400}–{set.filters.maxRating ?? 3000} · {set.order_mode === 'random' ? 'orden aleatorio' : 'orden fijo'}
          </div>
        </div>

        {set.status !== 'active' ? (
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:'20px 24px', textAlign:'center' }}>
            <div style={{ ...mono, fontSize:11, letterSpacing:2, textTransform:'uppercase', color: set.status === 'completed' ? C.correct : C.muted, marginBottom:8 }}>
              {set.status === 'completed' ? '¡Set completado!' : 'Set abandonado'}
            </div>
            <div style={{ fontSize:12, color:C.muted }}>
              {stats.length} ciclo{stats.length !== 1 && 's'} realizado{stats.length !== 1 && 's'}
            </div>
          </div>
        ) : (
          <>
            {/* Ciclo actual */}
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding:'20px 22px' }}>
              <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:12 }}>
                <div>
                  <div style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.muted, marginBottom:4 }}>Ciclo actual</div>
                  <div style={{ ...cinzel, fontSize:36, fontWeight:900, color:C.amber, lineHeight:1 }}>
                    {set.current_cycle} <span style={{ color:C.muted, fontSize:24 }}>/ {set.total_cycles}</span>
                  </div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginBottom:4 }}>Progreso</div>
                  <div style={{ ...mono, fontSize:20, fontWeight:700, color:C.text }}>{doneCount} / {set.size}</div>
                </div>
              </div>
              {/* Barra */}
              <div style={{ height:6, background:C.border, borderRadius:3, overflow:'hidden', marginBottom:14 }}>
                <div style={{ height:'100%', width:`${(doneCount / set.size) * 100}%`, background:C.amber, transition:'width .3s' }} />
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
                <StatCell label="Tiempo" value={currentStats ? fmtDurationHuman(currentStats.total_ms) : '—'} />
                <StatCell label="Errores" value={currentStats ? String(currentStats.errors) : '—'} color={currentStats && currentStats.errors > 0 ? C.red : undefined} />
                <StatCell label="Meta" value={targetMs ? fmtDurationHuman(targetMs) : '—'} color={C.amber} />
              </div>
            </div>

            {/* Botón principal */}
            <button onClick={onStart}
              style={{ width:'100%', padding:'16px', borderRadius:12, background:C.amber, border:'none', color:C.bg, fontSize:15, fontWeight:700, fontFamily:'inherit', cursor:'pointer' }}>
              {done ? 'Cerrar ciclo y ver resumen' : (doneCount === 0 ? `Empezar ciclo ${set.current_cycle}` : 'Continuar ciclo')}
            </button>

            {/* Retry de errores de la última sesión — sólo si hay algo que reintentar.
                Estos intentos van con is_retry=true en DB y no afectan el
                score/tiempo del ciclo (son estudio, no la performance oficial). */}
            {lastSessionErrors > 0 && (
              <button onClick={onRetry}
                style={{ width:'100%', padding:'12px', borderRadius:10, background:C.infoBg, border:`1px solid ${C.borderInfo}`, color:C.info, fontSize:13, fontWeight:600, fontFamily:'inherit', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                ↻ Reintentar errores del ciclo ({lastSessionErrors})
              </button>
            )}

            {/* Próxima sesión programada — recordatorio in-app (sin push aún).
                El campo next_session_at ya está persistido; la ListScreen
                muestra un borde ámbar en el card cuando la fecha ya llegó. */}
            <NextSessionCard
              set={set}
              onUpdate={async (dt) => {
                await updateSet(set.id, { next_session_at: dt })
                reload()
              }}
            />
          </>
        )}

        {/* Historial de ciclos */}
        {stats.length > 0 && (
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:'16px 20px' }}>
            <div style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.muted, marginBottom:10 }}>Historial de ciclos</div>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...mono, fontSize:9, color:C.muted, textAlign:'left', paddingBottom:6, fontWeight:400 }}>#</th>
                  <th style={{ ...mono, fontSize:9, color:C.muted, textAlign:'right', paddingBottom:6, fontWeight:400 }}>Tiempo</th>
                  <th style={{ ...mono, fontSize:9, color:C.muted, textAlign:'right', paddingBottom:6, fontWeight:400 }}>Errores</th>
                  <th style={{ ...mono, fontSize:9, color:C.muted, textAlign:'right', paddingBottom:6, fontWeight:400 }}>Δ vs anterior</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((c, i) => {
                  const p = i > 0 ? stats[i - 1] : null
                  const delta = p ? Math.round(((c.total_ms - p.total_ms) / p.total_ms) * 100) : null
                  return (
                    <tr key={c.cycle} style={{ borderTop:`1px solid ${C.border}` }}>
                      <td style={{ ...mono, fontSize:12, color: c.cycle === set.current_cycle ? C.amber : C.text, padding:'8px 0', fontWeight: c.cycle === set.current_cycle ? 700 : 400 }}>
                        {c.cycle}
                      </td>
                      <td style={{ ...mono, fontSize:12, color:C.text, textAlign:'right', padding:'8px 0' }}>{fmtDurationHuman(c.total_ms)}</td>
                      <td style={{ ...mono, fontSize:12, color: c.errors > 0 ? C.red : C.text, textAlign:'right', padding:'8px 0' }}>{c.errors}</td>
                      <td style={{ ...mono, fontSize:11, color: delta === null ? C.faint : (delta < 0 ? C.correct : C.muted), textAlign:'right', padding:'8px 0' }}>
                        {delta === null ? '—' : (delta > 0 ? `+${delta}%` : `${delta}%`)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Acciones — cerrar ciclo (más liviano) y abandonar set (destructivo) */}
        {set.status === 'active' && (
          <div style={{ marginTop:8, display:'flex', flexDirection:'column', gap:12, alignItems:'center' }}>
            {/* Cerrar ciclo actual — sólo tiene sentido si hay progreso Y todavía no lo terminaste */}
            {doneCount > 0 && !done && (
              !confirmCloseCycle ? (
                <button onClick={() => setConfirmCloseCycle(true)}
                  style={{ ...mono, fontSize:10, letterSpacing:2, textTransform:'uppercase', color:C.muted, background:'none', border:'none', padding:'6px 0', cursor:'pointer' }}>
                  Cerrar ciclo actual y pasar al siguiente
                </button>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:8, alignItems:'center', padding:'12px 16px', background:C.surface, border:`1px solid ${C.borderAm}`, borderRadius:10, maxWidth:420 }}>
                  <div style={{ fontSize:12, color:C.text, textAlign:'center', lineHeight:1.5 }}>
                    ¿Cerrar el ciclo <strong>{set.current_cycle}</strong> con <strong>{doneCount}/{set.size}</strong> puzzles?
                  </div>
                  <div style={{ fontSize:11, color:C.muted, textAlign:'center', lineHeight:1.4 }}>
                    La meta del ciclo {set.current_cycle + 1} se calculará sobre el tiempo parcial.
                    {set.current_cycle >= set.total_cycles && ' Es el último ciclo — el set queda completado.'}
                  </div>
                  <div style={{ display:'flex', gap:8 }}>
                    <button onClick={() => setConfirmCloseCycle(false)}
                      style={{ padding:'8px 16px', borderRadius:8, background:C.surface2, border:`1px solid ${C.border}`, color:C.muted, fontSize:12, cursor:'pointer' }}>
                      Cancelar
                    </button>
                    <button onClick={doCloseCycle}
                      style={{ padding:'8px 16px', borderRadius:8, background:C.amber, border:'none', color:C.bg, fontSize:12, fontWeight:700, cursor:'pointer' }}>
                      {set.current_cycle >= set.total_cycles ? 'Completar set' : `Pasar a ciclo ${set.current_cycle + 1}`}
                    </button>
                  </div>
                </div>
              )
            )}

            {/* Abandonar set — acción más destructiva */}
            {!confirmAbandon ? (
              <button onClick={() => setConfirmAbandon(true)}
                style={{ ...mono, fontSize:10, letterSpacing:2, textTransform:'uppercase', color:C.muted, background:'none', border:'none', padding:'6px 0', cursor:'pointer' }}>
                Abandonar set
              </button>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:8, alignItems:'center' }}>
                <div style={{ fontSize:12, color:C.red }}>¿Seguro? No se puede deshacer.</div>
                <div style={{ display:'flex', gap:8 }}>
                  <button onClick={() => setConfirmAbandon(false)}
                    style={{ padding:'8px 16px', borderRadius:8, background:C.surface, border:`1px solid ${C.border}`, color:C.muted, fontSize:12, cursor:'pointer' }}>
                    Cancelar
                  </button>
                  <button onClick={doAbandonSet}
                    style={{ padding:'8px 16px', borderRadius:8, background:C.red, border:'none', color:'#fff', fontSize:12, fontWeight:700, cursor:'pointer' }}>
                    Abandonar
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Modal explicando el método del Pájaro Carpintero ────────────────────
// Accesible desde el ícono ⓘ en las pantallas de la sección. Cuenta la
// historia del método y cómo se usa dentro de Shajmat.
function MethodInfoModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div onClick={onClose} style={{
      position:'fixed', inset:0, zIndex:100, background:'rgba(0,0,0,0.6)',
      display:'flex', alignItems:'center', justifyContent:'center', padding:16,
    }}>
      <div onClick={(e)=>e.stopPropagation()} style={{
        background:C.surface, border:`1px solid ${C.border}`, borderRadius:14,
        padding:'24px 28px 22px', maxWidth:520, width:'100%', color:C.text,
        fontFamily:"'DM Sans',system-ui,sans-serif", maxHeight:'85vh', overflowY:'auto',
      }}>
        <div style={{ ...cinzel, fontSize:18, fontWeight:700, letterSpacing:2, marginBottom:6 }}>MÉTODO DEL PÁJARO CARPINTERO</div>
        <div style={{ ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginBottom:16 }}>
          Axel Smith & Hans Tikkanen · 2018
        </div>

        <div style={{ fontSize:14, color:C.text, lineHeight:1.6, marginBottom:14 }}>
          Un método de entrenamiento táctico basado en <strong>repetición espaciada</strong>: elegís un set fijo de puzzles y lo resolvés entero. Después volvés a empezar desde el primero, apuntando a hacerlo en la mitad del tiempo. Y así por 7 ciclos.
        </div>
        <div style={{ fontSize:14, color:C.muted, lineHeight:1.6, marginBottom:18 }}>
          La idea: no es la variedad de puzzles lo que entrena, sino la <span style={{ color:C.text }}>repetición de los mismos patrones</span> hasta que los reconocés al instante. En el último ciclo deberías ver soluciones que en el primer ciclo te llevaron minutos.
        </div>

        <div style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.muted, marginBottom:8 }}>Cómo funciona en Shajmat</div>
        <ul style={{ listStyle:'none', padding:0, margin:0, display:'flex', flexDirection:'column', gap:10, marginBottom:16 }}>
          <li style={{ fontSize:13, color:C.text, lineHeight:1.5 }}>
            <strong style={{ color:C.amber }}>1.</strong> Creás un set — elegís tamaño (60 a 500 puzzles), rating y temas. Los IDs se congelan y se repiten en cada ciclo.
          </li>
          <li style={{ fontSize:13, color:C.text, lineHeight:1.5 }}>
            <strong style={{ color:C.amber }}>2.</strong> Ciclo 1: resolvés todos los puzzles en varias sesiones. Cada intento se cronometra.
          </li>
          <li style={{ fontSize:13, color:C.text, lineHeight:1.5 }}>
            <strong style={{ color:C.amber }}>3.</strong> Ciclo 2 en adelante: mismos puzzles, meta = mitad del tiempo anterior. Vas viendo si mejorás.
          </li>
          <li style={{ fontSize:13, color:C.text, lineHeight:1.5 }}>
            <strong style={{ color:C.amber }}>4.</strong> Si fallás uno, entrás en <span style={{ color:C.info }}>modo análisis</span>: podés explorar, ver la solución y activar el motor. El error queda registrado pero no te impide seguir.
          </li>
        </ul>

        <div style={{ fontSize:12, color:C.muted, lineHeight:1.5, padding:'10px 14px', background:C.surface2, borderRadius:8, border:`1px solid ${C.border}` }}>
          <strong style={{ color:C.text }}>Tip:</strong> arrancá con un set chico (60–100 puzzles) para que cada ciclo entre en 30–60 minutos. Podés tener varios sets en paralelo con distintos temas.
        </div>

        <button onClick={onClose}
          style={{ marginTop:20, width:'100%', padding:'12px', borderRadius:10, background:C.amber, border:'none', color:C.bg, fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:700, cursor:'pointer' }}>
          Entendido
        </button>
      </div>
    </div>
  )
}

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ textAlign:'center' }}>
      <div style={{ ...mono, fontSize: 20, fontWeight:700, color: color ?? C.text, lineHeight:1 }}>{value}</div>
      <div style={{ ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginTop:4 }}>{label}</div>
    </div>
  )
}

// ── Card "Recordatorio de próxima sesión" ────────────────────────────────
// Muestra el datetime guardado (formateado), presets rápidos que quedan
// resaltados si el valor guardado coincide con ellos, y date + time picker
// separados para override fino. Cambios se guardan en vivo — sin botón
// "Guardar" que sea redundante con los inputs. En v1.1 se agrega push;
// hoy sólo persiste el datetime y la ListScreen resalta cards en fecha.
function NextSessionCard({ set, onUpdate }: {
  set: WoodpeckerSet
  onUpdate: (dt: string | null) => Promise<void>
}) {
  const [saving, setSaving] = useState(false)

  const parsed = set.next_session_at ? new Date(set.next_session_at) : null
  const isPast = parsed ? parsed <= new Date() : false

  const persist = async (dt: Date | null) => {
    setSaving(true)
    try { await onUpdate(dt ? dt.toISOString() : null) }
    finally { setSaving(false) }
  }

  // Aplica un preset con hora default 9:00. Si ya había una hora guardada,
  // la mantenemos (el user eligió esa hora explícitamente antes).
  const applyPreset = (days: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    if (parsed) d.setHours(parsed.getHours(), parsed.getMinutes(), 0, 0)
    else        d.setHours(9, 0, 0, 0)
    persist(d)
  }

  // Update sólo fecha (mantiene hora actual — o 9am si no había).
  const updateDate = (dateStr: string) => {
    if (!dateStr) return
    const [y, m, d] = dateStr.split('-').map(n => parseInt(n, 10))
    const nd = parsed ? new Date(parsed) : new Date()
    nd.setFullYear(y, m - 1, d)
    if (!parsed) nd.setHours(9, 0, 0, 0)
    persist(nd)
  }

  // Update sólo hora (mantiene fecha actual — o hoy si no había).
  const updateTime = (timeStr: string) => {
    if (!timeStr) return
    const [h, min] = timeStr.split(':').map(n => parseInt(n, 10))
    const nd = parsed ? new Date(parsed) : new Date()
    nd.setHours(h, min, 0, 0)
    persist(nd)
  }

  // ¿Qué preset (si alguno) matchea el datetime guardado? Comparamos por
  // días de diferencia respecto a HOY. Ej: si saved = mañana, "1 día"
  // queda highlight. La hora no importa para este match.
  const activePresetDays = (() => {
    if (!parsed) return null
    const today = new Date(); today.setHours(0,0,0,0)
    const savedDay = new Date(parsed); savedDay.setHours(0,0,0,0)
    const diffDays = Math.round((savedDay.getTime() - today.getTime()) / (24*60*60*1000))
    return diffDays
  })()

  // Valores para los inputs (formato YYYY-MM-DD y HH:MM).
  const pad = (n: number) => n.toString().padStart(2, '0')
  const dateValue = parsed
    ? `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
    : ''
  const timeValue = parsed ? `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}` : ''

  const formatted = parsed
    ? parsed.toLocaleString('es-AR', {
        weekday: 'long', day: 'numeric', month: 'long',
        hour: '2-digit', minute: '2-digit', hour12: false,
      })
    : null

  const presets = [
    { label: 'En 1 día',   days: 1 },
    { label: 'En 3 días',  days: 3 },
    { label: 'En 1 semana', days: 7 },
  ]

  return (
    <div style={{ background:C.surface, border:`1px solid ${isPast ? C.borderAm : C.border}`, borderRadius:12, padding:'14px 18px', display:'flex', flexDirection:'column', gap:12 }}>
      <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:12 }}>
        <div style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.muted }}>
          Recordatorio de próxima sesión
        </div>
        {parsed && (
          <button onClick={() => persist(null)} disabled={saving}
            style={{ ...mono, fontSize:10, letterSpacing:1, textTransform:'uppercase', color:C.muted, background:'none', border:'none', cursor:'pointer', padding:0 }}>
            Quitar
          </button>
        )}
      </div>

      {parsed ? (
        <div style={{ fontSize:15, color: isPast ? C.amber : C.text, fontWeight:600, textTransform:'capitalize' }}>
          {isPast && <span style={{ ...mono, fontSize:10, letterSpacing:2, textTransform:'uppercase', color:C.amber, marginRight:8 }}>Hoy · </span>}
          {formatted}
        </div>
      ) : (
        <div style={{ fontSize:13, color:C.muted }}>Sin recordatorio. Elegí cuándo querés volver.</div>
      )}

      {/* Presets — se resaltan en ámbar cuando su días coincide con el guardado */}
      <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
        {presets.map(p => {
          const active = activePresetDays === p.days
          return (
            <button key={p.days} onClick={() => applyPreset(p.days)} disabled={saving}
              style={{
                flex:'1 1 100px', padding:'8px 12px', borderRadius:8,
                background: active ? C.amberBg : C.surface2,
                border: `1px solid ${active ? C.borderAm : C.border}`,
                color:   active ? C.amber : C.muted,
                fontSize:12, fontWeight: active ? 700 : 500, fontFamily:'inherit',
                cursor: saving ? 'not-allowed' : 'pointer',
                transition:'background .15s, color .15s, border-color .15s',
              }}>
              {p.label}
            </button>
          )
        })}
      </div>

      {/* Fecha + hora — cambios se guardan en vivo, sin botón redundante */}
      <div style={{ display:'flex', gap:8, alignItems:'center' }}>
        <label style={{ flex:1, display:'flex', flexDirection:'column', gap:4 }}>
          <span style={{ ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase', color:C.muted }}>Fecha</span>
          <input type="date" value={dateValue} onChange={e => updateDate(e.target.value)} disabled={saving}
            style={{ padding:'8px 10px', borderRadius:8, background:C.surface2, border:`1px solid ${C.border}`, color:C.text, fontSize:12, fontFamily:'inherit' }} />
        </label>
        <label style={{ width:110, display:'flex', flexDirection:'column', gap:4 }}>
          <span style={{ ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase', color:C.muted }}>Hora</span>
          <input type="time" value={timeValue} onChange={e => updateTime(e.target.value)} disabled={saving}
            style={{ padding:'8px 10px', borderRadius:8, background:C.surface2, border:`1px solid ${C.border}`, color:C.text, fontSize:12, fontFamily:'inherit' }} />
        </label>
      </div>
    </div>
  )
}

// ══ 5. SolvingScreen — resolver puzzles del ciclo ═════════════════════════════
//
// Flujo:
//   - Cargamos el set, el orden del ciclo actual, y los attempts previos
//   - Determinamos por qué position seguir (loadCycleProgress)
//   - Cargamos los puzzles restantes en batch
//   - Por cada puzzle: cronometramos, validamos jugada. Si el user acierta
//     la primera, avanzamos. Si falla, entramos en modo EXPLORING: el
//     board vuelve a la posición inicial y el usuario puede jugar libremente,
//     navegar el historial, ver la solución bajo demanda, o pedir motor.
//     Cuando termina de explorar, aprieta "Continuar" y va al próximo.
//   - No hay skip; para avanzar hay que resolver o fallar.
//   - Al terminar el ciclo cerramos y vamos a CycleDoneScreen.

interface QueuedPuzzle {
  position: number
  puzzle:   Puzzle
}

// Nodo del historial en modo exploring — mismo shape que en el ReviewScreen.
interface AnalysisNode {
  fen: string
  san: string | null
  uci: string | null
}

// Helper local: mapa de destinos legales desde un Chess.
function computeDestsLocal(chess: Chess): Map<Key, Key[]> {
  const m = new Map<Key, Key[]>()
  for (const mv of chess.moves({ verbose: true })) {
    const arr = m.get(mv.from as Key)
    if (arr) arr.push(mv.to as Key)
    else m.set(mv.from as Key, [mv.to as Key])
  }
  return m
}

function SolvingScreen({ setId, onExit, onCycleDone, retryOnly }: {
  setId: string
  retryOnly?: boolean
  onExit: () => void
  onCycleDone: (cycleClosed: number) => void
}) {
  const desktop = useIsDesktop()
  const [set,        setSet]        = useState<WoodpeckerSet | null>(null)
  const [queue,      setQueue]      = useState<QueuedPuzzle[]>([])
  const [queueIdx,   setQueueIdx]   = useState(0)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string | null>(null)
  const sessionGroupId = useRef<string>(crypto.randomUUID())

  // ── Estado del puzzle activo ──
  //
  // feedback tiene dos "carriles":
  //   solving:   idle → thinking → solved (auto-avanza)
  //              idle → wrong-flash → exploring (usuario decide cuándo continuar)
  //   exploring: el usuario mueve libre, navega historial, ve solución
  //
  // Durante 'exploring' el board se maneja con `nodes`+`nodeIdx`; durante
  // solving se maneja con `chessRef`+`currentFen`+`moveIdx`.
  const [feedback,   setFeedback]   = useState<'idle'|'thinking'|'wrong-flash'|'solved'|'exploring'>('idle')
  const [currentFen, setCurrentFen] = useState('')
  const [lastMove,   setLastMove]   = useState<string | undefined>(undefined)
  const [moveIdx,    setMoveIdx]    = useState(0)
  const chessRef                    = useRef<Chess | null>(null)   // solving-only

  const [nodes,      setNodes]      = useState<AnalysisNode[]>([])  // exploring-only
  const [nodeIdx,    setNodeIdx]    = useState(0)
  const [animatingSolution, setAnimatingSolution] = useState(false)

  const [attemptedThisPuzzle, setAttemptedThisPuzzle] = useState(false)
  const [promotionPending, setPromotionPending] = useState<{orig:string,dest:string} | null>(null)
  const [boardResetSignal, setBoardResetSignal] = useState(0)

  // Motor (opcional, default OFF)
  const [engineOn,   setEngineOn]   = useState(false)
  const [evalInfo,   setEvalInfo]   = useState<EvalInfo | null>(null)
  const engineRef = useRef<StockfishEngine | null>(null)

  // Timing
  const puzzleStartMs = useRef<number>(Date.now())
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tick para re-renderizar el reloj cada segundo. En exploring se pausa
  // (no queremos que el tiempo del puzzle siga sumando mientras analizás).
  const [nowTick, setNowTick] = useState<number>(Date.now())
  useEffect(() => {
    if (feedback === 'exploring' || feedback === 'solved') return
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [feedback])

  const clearTimer = () => { if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null } }

  // ── Cargar set + progreso + puzzles ──
  useEffect(() => {
    let alive = true
    ;(async () => {
      const s = await getSet(setId)
      if (!alive || !s) return
      setSet(s)
      if (s.status !== 'active') { setError('Este set no está activo.'); setLoading(false); return }

      if (retryOnly) {
        // ── Modo retry: cargamos TODOS los puzzles fallados del ciclo
        // actual (deduplicados por position). NO afectan el cycle time
        // ni el score — es estudio, no la performance oficial.
        const errAttempts = await listCycleErrors(setId, s.current_cycle)
        if (!alive) return
        if (errAttempts.length === 0) {
          setError('No hay errores para reintentar en este ciclo.')
          setLoading(false)
          return
        }
        const dataMap = await fetchPuzzlesByIds(errAttempts.map(a => a.puzzle_id))
        if (!alive) return
        const q: QueuedPuzzle[] = errAttempts
          .map(a => ({ position: a.position, puzzle: dataMap.get(a.puzzle_id) }))
          .filter((x): x is QueuedPuzzle => !!x.puzzle)
        setCycleAccumulatedMs(0)  // no relevante en retry
        setQueue(q); setQueueIdx(0); setLoading(false)
        return
      }

      const prog = await loadCycleProgress(s)
      if (!alive) return
      const pending = prog.order.filter(p => !prog.completedPositions.has(p))
      if (pending.length === 0) {
        await closeCurrentCycleAndAdvance(s)
        if (!alive) return
        onCycleDone(s.current_cycle)
        return
      }
      const allIds = await getSetPuzzleIds(s.id)
      const idsWithPos = pending.map(pos => ({ pos, id: allIds[pos] })).filter(x => !!x.id)
      const dataMap = await fetchPuzzlesByIds(idsWithPos.map(x => x.id))
      if (!alive) return
      const q: QueuedPuzzle[] = idsWithPos
        .map(x => ({ position: x.pos, puzzle: dataMap.get(x.id) }))
        .filter((x): x is QueuedPuzzle => !!x.puzzle)
      // Tiempo acumulado del ciclo (sesiones anteriores) — el usuario ve
      // el cronómetro seguir sumando desde donde dejó, no arrancar en 0.
      const priorMs = prog.attempts.reduce((sum, a) => sum + (a.time_ms ?? 0), 0)
      // Timestamp del primer attempt del ciclo — para el "bruto" (wall-clock).
      const firstAt = prog.attempts.length > 0
        ? new Date(prog.attempts[0].attempted_at)
        : new Date()   // si no hay attempts, el ciclo empieza ahora
      if (alive) { setCycleAccumulatedMs(priorMs); setCycleStartAt(firstAt) }
      setQueue(q); setQueueIdx(0); setLoading(false)
    })()
    return () => { alive = false }
  }, [setId, onCycleDone, retryOnly])

  // ── Setup del puzzle activo cuando cambia queueIdx ──
  useEffect(() => {
    const current = queue[queueIdx]
    if (!current) return
    const c = new Chess(current.puzzle.fen)
    chessRef.current = c
    setCurrentFen(current.puzzle.fen)
    setMoveIdx(0)
    setLastMove(undefined)
    setFeedback('idle')
    setAttemptedThisPuzzle(false)
    setPromotionPending(null)
    setEvalInfo(null)
    setNodes([])
    setNodeIdx(0)
    setAnimatingSolution(false)
    puzzleStartMs.current = Date.now()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueIdx, queue.length])

  // ── Motor: crear/destruir según toggle ──
  useEffect(() => {
    if (!engineOn) return
    if (engineRef.current) return
    const eng = new StockfishEngine()
    engineRef.current = eng
    eng.onEval(info => setEvalInfo(info))
    return () => { eng.destroy(); engineRef.current = null }
  }, [engineOn])

  useEffect(() => {
    // Sólo analizar durante el modo exploratorio — en modo juego el motor
    // no se muestra y estaría consumiendo CPU al pedo.
    if (!engineOn || !currentFen || feedback !== 'exploring') return
    engineRef.current?.analyze(currentFen, { depth: 14 })
  }, [engineOn, currentFen, feedback])

  // Cleanup timeouts al desmontar
  useEffect(() => () => { clearTimer() }, [])

  const currentPuzzle = queue[queueIdx]?.puzzle
  const currentPosition = queue[queueIdx]?.position

  // dests: bloqueado durante animación/estados transitorios
  const dests = useMemo<Map<Key, Key[]>>(() => {
    if (!currentFen) return new Map()
    if (feedback === 'thinking' || feedback === 'solved' || feedback === 'wrong-flash') return new Map()
    if (animatingSolution) return new Map()
    try { return computeDestsLocal(new Chess(currentFen)) }
    catch { return new Map() }
  }, [currentFen, feedback, animatingSolution])

  const currentTurn: 'white'|'black' = currentFen
    ? (currentFen.split(' ')[1] === 'w' ? 'white' : 'black')
    : 'white'

  // ── Guardar attempt (sin avanzar) ──
  // Se llama INMEDIATAMENTE cuando el usuario resuelve o falla — así el
  // registro queda en DB aunque el usuario cierre la app en medio de la
  // exploración post-error. También devuelve el time_ms usado, para
  // que el caller pueda actualizar el acumulado local.
  const saveAttemptRef = useRef<number>(0)  // acumulado local del ciclo (agregamos live)
  const [cycleAccumulatedMs, setCycleAccumulatedMs] = useState<number>(0)
  // Timestamp del primer attempt del ciclo — para el tiempo "bruto"
  // (wall-clock desde que empezaste el ciclo, incluye pausas y tiempo away).
  const [cycleStartAt, setCycleStartAt] = useState<Date | null>(null)
  const saveAttempt = useCallback(async (correct: boolean): Promise<number> => {
    if (!set || !currentPuzzle || currentPosition === undefined) return 0
    const timeMs = Date.now() - puzzleStartMs.current
    // IMPORTANTE: actualizar el acumulado ANTES del await para no crear
    // una ventana donde liveMs=0 (por feedback='solved') pero el timeMs
    // aún no está sumado al accumulated. Sino, el reloj "vuelve para atrás"
    // por unos ms mientras esperamos la respuesta del insert.
    if (!retryOnly) {
      saveAttemptRef.current += timeMs
      setCycleAccumulatedMs(prev => prev + timeMs)
    }
    await recordAttempt({
      set_id:            set.id,
      cycle_number:      set.current_cycle,
      puzzle_id:         currentPuzzle.id,
      position:          currentPosition,
      time_ms:           timeMs,
      correct,
      // En modo retry: is_retry=true → estos attempts no cuentan para el
      // cycle time ni el score. Son estudio, no performance.
      is_retry:          !!retryOnly,
      session_group_id:  sessionGroupId.current,
    })
    return timeMs
  }, [set, currentPuzzle, currentPosition, retryOnly])

  // ── Avanzar al próximo puzzle o cerrar ciclo ──
  const advanceQueue = useCallback(async () => {
    if (!set) return
    clearTimer()
    if (queueIdx + 1 >= queue.length) {
      // En retry: al terminar todos los errores, volvemos al overview.
      // No cerramos el ciclo (los retries no son la performance del ciclo).
      if (retryOnly) { onExit(); return }
      await closeCurrentCycleAndAdvance(set)
      onCycleDone(set.current_cycle)
      return
    }
    setQueueIdx(i => i + 1)
  }, [set, queueIdx, queue.length, onCycleDone, onExit, retryOnly])

  // ── handleMove: doble modo (solving | exploring) ──
  const handleMove = useCallback((orig: string, dest: string, promotion?: PromoPiece) => {
    if (!currentPuzzle) return
    if (feedback === 'thinking' || feedback === 'wrong-flash' || feedback === 'solved') return
    if (animatingSolution) return

    // Detectar promoción (común a los dos modos)
    if (!promotion) {
      try {
        const probe = new Chess(currentFen)
        const piece = probe.get(orig as never)
        const destRank = dest[1]
        const isPromo = piece?.type === 'p' && (
          (piece.color === 'w' && destRank === '8') ||
          (piece.color === 'b' && destRank === '1')
        )
        if (isPromo) { setPromotionPending({ orig, dest }); return }
      } catch {}
    }

    // ── Modo EXPLORING: free play, con historial ──
    if (feedback === 'exploring') {
      let m
      const c = new Chess(currentFen)
      try { m = c.move({ from: orig, to: dest, promotion: promotion ?? 'q' }) }
      catch { return }
      if (!m) return
      const newFen = c.fen()
      const uci = orig + dest + (promotion ?? '')
      setNodes(prev => {
        // Si el user estaba navegado atrás, truncamos y ramificamos
        const trimmed = prev.slice(0, nodeIdx + 1)
        return [...trimmed, { fen: newFen, san: m!.san, uci }]
      })
      setNodeIdx(i => i + 1)
      setCurrentFen(newFen)
      setLastMove(uci)
      playMove()
      return
    }

    // ── Modo SOLVING ──
    if (!chessRef.current) return
    const chess = chessRef.current
    const expected = currentPuzzle.solution[moveIdx]
    const userMove = orig + dest + (promotion ?? '')
    const isCorrect = validateMoveUci(currentFen, userMove, expected)

    if (!isCorrect) {
      setFeedback('wrong-flash')
      setAttemptedThisPuzzle(true)
      playWrong()
      // Guardamos el attempt YA (correct=false). Si el usuario cierra la
      // app mientras explora, el error queda registrado y al volver
      // arranca en el próximo puzzle — no re-intenta este.
      saveAttempt(false)
      // Después del flash rojo, entramos en modo exploring desde la posición inicial.
      timeoutRef.current = setTimeout(() => {
        const c2 = new Chess(currentPuzzle.fen)
        chessRef.current = c2
        setCurrentFen(currentPuzzle.fen)
        setLastMove(undefined)
        setMoveIdx(0)
        setNodes([{ fen: currentPuzzle.fen, san: null, uci: null }])
        setNodeIdx(0)
        setFeedback('exploring')
      }, 500)
      return
    }

    // Correcta: aplicar, actualizar
    let m
    try { m = chess.move({ from: orig, to: dest, promotion: promotion ?? 'q' }) }
    catch { return }
    if (!m) return
    setLastMove(userMove)
    setCurrentFen(chess.fen())
    const nextMoveIdx = moveIdx + 1
    if (nextMoveIdx >= currentPuzzle.solution.length) {
      // Puzzle resuelto en primera → correct
      setFeedback('solved')
      playCorrect()
      // saveAttempt inmediato (defensivo, aunque el usuario no espere el
      // avance automático). Después de un breve delay, avanzamos.
      saveAttempt(!attemptedThisPuzzle)
      timeoutRef.current = setTimeout(() => {
        advanceQueue()
      }, 550)
      return
    }
    // Rival responde
    setFeedback('thinking')
    setMoveIdx(nextMoveIdx)
    timeoutRef.current = setTimeout(() => {
      const opp = currentPuzzle.solution[nextMoveIdx]
      try {
        chess.move({
          from: opp.slice(0,2), to: opp.slice(2,4),
          promotion: opp.length > 4 ? (opp[4] as 'q'|'r'|'b'|'n') : undefined,
        })
        setCurrentFen(chess.fen())
        setLastMove(opp)
        setMoveIdx(nextMoveIdx + 1)
        setFeedback('idle')
        playMove()
      } catch {}
    }, 320)
  }, [feedback, animatingSolution, currentPuzzle, moveIdx, currentFen, nodeIdx, attemptedThisPuzzle, saveAttempt, advanceQueue])

  const resolvePromotion = useCallback((p: PromoPiece) => {
    if (!promotionPending) return
    const { orig, dest } = promotionPending
    setPromotionPending(null)
    handleMove(orig, dest, p)
  }, [promotionPending, handleMove])
  const cancelPromotion = useCallback(() => {
    setPromotionPending(null); setBoardResetSignal(s => s + 1)
  }, [])

  // ── Handlers de EXPLORING ──
  const canPrev = feedback === 'exploring' && nodeIdx > 0
  const canNext = feedback === 'exploring' && nodeIdx < nodes.length - 1

  const goToNode = useCallback((idx: number) => {
    if (feedback !== 'exploring') return
    if (animatingSolution) return
    const clamped = Math.max(0, Math.min(nodes.length - 1, idx))
    setNodeIdx(clamped)
    setCurrentFen(nodes[clamped].fen)
    setLastMove(nodes[clamped].uci ?? undefined)
  }, [feedback, animatingSolution, nodes])

  const goPrev  = useCallback(() => goToNode(nodeIdx - 1), [goToNode, nodeIdx])
  const goNext  = useCallback(() => goToNode(nodeIdx + 1), [goToNode, nodeIdx])
  const goFirst = useCallback(() => goToNode(0), [goToNode])
  const goLast  = useCallback(() => goToNode(nodes.length - 1), [goToNode, nodes.length])

  // Reset a posición inicial durante exploring
  const resetPosition = useCallback(() => {
    if (feedback !== 'exploring' || !currentPuzzle) return
    clearTimer()
    setAnimatingSolution(false)
    setNodes([{ fen: currentPuzzle.fen, san: null, uci: null }])
    setNodeIdx(0)
    setCurrentFen(currentPuzzle.fen)
    setLastMove(undefined)
  }, [feedback, currentPuzzle])

  // Animar la solución completa (bajo demanda del user)
  const playSolution = useCallback(() => {
    if (feedback !== 'exploring' || !currentPuzzle || animatingSolution) return
    setAnimatingSolution(true)
    // Empezamos desde la posición inicial
    const startNodes: AnalysisNode[] = [{ fen: currentPuzzle.fen, san: null, uci: null }]
    setNodes(startNodes)
    setNodeIdx(0)
    setCurrentFen(currentPuzzle.fen)
    setLastMove(undefined)
    const c = new Chess(currentPuzzle.fen)
    let step = 0
    const playStep = () => {
      if (step >= currentPuzzle.solution.length) {
        setAnimatingSolution(false)
        return
      }
      const uci = currentPuzzle.solution[step]
      let m
      try {
        m = c.move({
          from: uci.slice(0,2), to: uci.slice(2,4),
          promotion: uci.length > 4 ? (uci[4] as 'q'|'r'|'b'|'n') : undefined,
        })
      } catch { setAnimatingSolution(false); return }
      if (!m) { setAnimatingSolution(false); return }
      const newFen = c.fen()
      setNodes(ns => [...ns, { fen: newFen, san: m!.san, uci }])
      setNodeIdx(i => i + 1)
      setCurrentFen(newFen)
      setLastMove(uci)
      playMove()
      step += 1
      timeoutRef.current = setTimeout(playStep, 700)
    }
    timeoutRef.current = setTimeout(playStep, 300)
  }, [feedback, currentPuzzle, animatingSolution])

  // El attempt ya se guardó cuando el usuario falló (ver handleMove).
  // Continuar sólo avanza al próximo puzzle — sin registrar de nuevo.
  const continueToNext = useCallback(() => { clearTimer(); advanceQueue() }, [advanceQueue])

  // Keyboard shortcuts para navegar durante exploring
  useEffect(() => {
    if (feedback !== 'exploring') return
    const onKey = (e: KeyboardEvent) => {
      if (promotionPending) return
      if (e.key === 'ArrowLeft')  { e.preventDefault(); goPrev() }
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext() }
      if (e.key === 'Home')       { e.preventDefault(); goFirst() }
      if (e.key === 'End')        { e.preventDefault(); goLast() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [feedback, promotionPending, goPrev, goNext, goFirst, goLast])

  // ── Render ──
  if (loading) {
    return (
      <div style={{ minHeight:'100vh', background:C.bg, display:'flex', alignItems:'center', justifyContent:'center', color:C.muted, ...mono, fontSize:12 }}>
        Cargando puzzles del ciclo...
      </div>
    )
  }
  if (error) {
    return (
      <div style={{ minHeight:'100vh', background:C.bg, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:12 }}>
        <div style={{ fontSize:14, color:C.red }}>{error}</div>
        <button onClick={onExit} style={{ padding:'8px 16px', borderRadius:8, background:C.surface, border:`1px solid ${C.border}`, color:C.muted, cursor:'pointer' }}>Volver</button>
      </div>
    )
  }
  if (!currentPuzzle || !set) return null

  const donePuzzlesInSession = queueIdx
  const totalInSet = set.size
  const positionInCycle = totalInSet - (queue.length - queueIdx) + 1

  const bestArrow: DrawShape[] = engineOn && evalInfo && evalInfo.fen === currentFen && evalInfo.pv?.[0]?.length >= 4
    ? [{ orig: evalInfo.pv[0].slice(0, 2) as Key, dest: evalInfo.pv[0].slice(2, 4) as Key, brush: 'blue' }]
    : []

  const isExploring = feedback === 'exploring'
  // Cuántos puzzles llevamos en este ciclo (incluyendo sesiones anteriores).
  // = puzzles del set - los que quedan por delante en la queue
  const cycleDoneCount = totalInSet - (queue.length - queueIdx)
  const nextPuzzleNumber = Math.min(positionInCycle + 1, totalInSet)

  // Superficie base de las cards según el modo — en exploring queda una
  // capa apenas más clara sobre el azul oscuro; en solving el surface normal.
  const cardSurface = isExploring ? C.exploringSurface : C.surface

  return (
    <div style={{
      minHeight:'100vh',
      background: C.bg,
      padding: '16px 16px 20px',
      fontFamily: "'DM Sans',system-ui,sans-serif",
    }}>
      <div style={{ maxWidth:920, margin:'0 auto', display:'flex', flexDirection:'column', gap:10 }}>

        {/* ═══ SERIES HEADER unificado ═══
            Persiste en los dos modos. En exploring además se agrega un chip
            "⏸ ANÁLISIS" a la izquierda y el botón "Volver a la serie" ámbar
            a la derecha (donde antes vivía "Terminar sesión"). No hay rail
            separado — todo entra en una sola fila que no roba vertical. */}
        <div>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6, gap:12, flexWrap:'wrap' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', flex:'1 1 auto', minWidth:0 }}>
              <div style={{ ...mono, fontSize:10, letterSpacing: desktop ? 3 : 2, textTransform:'uppercase', color:C.muted }}>
                {retryOnly
                  ? <>Reintento · {set.name} · <span style={{ color:C.text, fontWeight:700 }}>{queueIdx + 1}/{queue.length}</span></>
                  : <>Serie · {set.name} · Ciclo {set.current_cycle}/{set.total_cycles} · <span style={{ color:C.text, fontWeight:700 }}>{cycleDoneCount}/{totalInSet}</span></>}
              </div>
              {retryOnly && (
                <span style={{
                  ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase',
                  background:C.infoBg, color:C.info,
                  border:`1px solid ${C.borderInfo}`,
                  padding:'2px 8px', borderRadius:20, fontWeight:700, whiteSpace:'nowrap',
                }}>
                  ↻ Estudio · no cuenta
                </span>
              )}
              {isExploring && (
                <span style={{
                  ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase',
                  background:C.infoBg, color:C.info,
                  border:`1px solid ${C.borderInfo}`,
                  padding:'2px 8px', borderRadius:20, fontWeight:700, whiteSpace:'nowrap',
                }}>
                  ⏸ {animatingSolution ? 'Mostrando solución' : 'Análisis · pausa'}
                </span>
              )}
            </div>
            <div style={{ display:'flex', alignItems:'center', gap: desktop ? 14 : 8, flexShrink:0 }}>
              <button onClick={onExit}
                style={{ ...mono, fontSize:10, letterSpacing:2, textTransform:'uppercase', color:C.muted, background:'none', border:'none', cursor:'pointer', padding:'2px 0', whiteSpace:'nowrap' }}>
                {retryOnly ? 'Volver' : (desktop ? 'Terminar sesión' : 'Terminar')}
              </button>
              {isExploring && (
                <button onClick={continueToNext}
                  style={{
                    padding: desktop ? '8px 14px' : '8px 12px', borderRadius:8,
                    background:C.amber, border:'none', color:C.bg,
                    fontSize:12, fontWeight:700, fontFamily:'inherit',
                    cursor:'pointer', whiteSpace:'nowrap',
                  }}>
                  {desktop
                    ? `Volver a la serie · Puzzle ${nextPuzzleNumber} →`
                    : `→ Puzzle ${nextPuzzleNumber}`}
                </button>
              )}
            </div>
          </div>
          {/* Barra de progreso — en retry muestra progreso de los N errores
              que estás reintentando; en ciclo normal, progreso del ciclo. */}
          <div style={{ height:4, background:C.border, borderRadius:2, overflow:'hidden' }}>
            <div style={{
              height:'100%',
              width:`${(retryOnly ? (queueIdx / Math.max(1, queue.length)) : (cycleDoneCount / totalInSet)) * 100}%`,
              background: retryOnly ? C.info : C.amber,
              transition:'width .3s',
            }} />
          </div>
        </div>

        <div style={{ display:'flex', gap: desktop ? 16 : 10, alignItems:'flex-start', flexWrap:'wrap', flexDirection: desktop ? 'row' : 'column' }}>
          {/* Board area — desktop: 600px fijo. Mobile: width 100% con
              aspectRatio 1, para que quepa en cualquier viewport. El
              sidebar en mobile se apila debajo. */}
          <div style={{ flex: desktop ? '0 0 auto' : '1 1 auto', width: desktop ? undefined : '100%', minWidth: 0 }}>
            <div style={{ display:'flex', gap:6, marginBottom:8, flexWrap:'wrap' }}>
              <span style={{ fontSize:11, background:C.surface, color:C.muted, padding:'3px 10px', borderRadius:20, border:`1px solid ${C.border}` }}>{currentPuzzle.theme}</span>
              <span style={{ ...mono, fontSize:11, background:C.amberBg, color:C.amber, padding:'3px 10px', borderRadius:20, border:`1px solid ${C.borderAm}` }}>ELO {currentPuzzle.rating}</span>
              <span style={{ fontSize:11, background:C.surface, color:C.muted, padding:'3px 10px', borderRadius:20, border:`1px solid ${C.border}` }}>{currentTurn === 'white' ? 'Blancas' : 'Negras'} juegan</span>
              {attemptedThisPuzzle && <span style={{ ...mono, fontSize:10, background:C.redBg, color:C.red, padding:'3px 10px', borderRadius:20, border:`1px solid ${C.red}30`, letterSpacing:1, textTransform:'uppercase' }}>Fallado</span>}
            </div>

            {/* Fila board + slot de eval bar a la DERECHA.
                Desktop: slot sólo aparece en exploring (en solving el
                board queda solo, ancho 600 fijo — no hay reflow).
                Mobile: reservamos el slot SIEMPRE (26px) para que el
                board no se achique al entrar a exploring. En solving el
                slot queda invisible; en exploring aparece el bar cuando
                se prende el motor. Board ancho estable entre modos. */}
            <div style={{ display:'flex', gap: (isExploring || !desktop) ? 8 : 0, alignItems:'flex-start' }}>
              {/* En exploring: borde azul distintivo alrededor del tablero.
                  Desktop: 600px fijo. Mobile: crece a lo que sobra en la
                  fila (viewport width menos el ancho del eval bar cuando
                  está prendido). El ChessBoard tiene aspectRatio:1 así que
                  la altura sale sola. */}
              <div style={{
                width: desktop ? 600 : '100%',
                aspectRatio: '1',
                minWidth: 0,
                flex: desktop ? '0 0 auto' : '1 1 auto',
                position:'relative', borderRadius:8, overflow:'hidden',
                boxShadow: feedback === 'exploring'
                  ? `0 0 0 3px ${C.borderInfo}, 0 8px 40px rgba(0,0,0,.5)`
                  : '0 8px 40px rgba(0,0,0,.5)',
                transition: 'box-shadow .25s',
              }}>
                <ChessBoard
                key={currentPuzzle.id}
                fen={currentFen}
                orientation={currentPuzzle.turn}
                turn={currentTurn}
                dests={dests}
                onMove={handleMove}
                feedback={feedback === 'solved' ? 'correct' : (feedback === 'wrong-flash' ? 'wrong' : 'idle')}
                showDests
                extraShapes={bestArrow}
                lastMove={lastMove}
                inputLocked={!!promotionPending || feedback === 'thinking' || feedback === 'solved' || feedback === 'wrong-flash' || animatingSolution}
                resetSignal={boardResetSignal}
              />
              {promotionPending && (
                <PromotionSelector
                  square={promotionPending.dest}
                  color={currentTurn}
                  orientation={currentPuzzle.turn}
                  onChoose={resolvePromotion}
                  onCancel={cancelPromotion}
                />
              )}
              {/* Overlay azul sutil sobre el board en modo exploración —
                  refuerza visualmente que estás en pausa, sin cambiar
                  los colores del tablero base. pointer-events: none deja
                  pasar los clicks al chessground que está debajo. */}
              {isExploring && (
                <div style={{
                  position:'absolute', inset:0, zIndex: 1,
                  background:'rgba(107,149,214,0.08)',
                  pointerEvents:'none',
                  transition:'background .25s',
                }} />
              )}
              </div>

              {/* Slot de eval bar — reservado siempre en exploring (desktop)
                  o en cualquier estado en mobile. Así el board mantiene el
                  mismo ancho al entrar/salir de exploring o al toggle motor.
                  Altura sigue al board (aspectRatio 1). */}
              {(isExploring || !desktop) && (
                <div style={{ width: 26, alignSelf: 'stretch', flexShrink: 0, position: 'relative' }}>
                  {isExploring && engineOn && (() => {
                    const frac = evalInfo && evalInfo.fen === currentFen ? evalToBarFraction(evalInfo) : 0.5
                    const showAtBottom = frac >= 0.5
                    return (
                      <div style={{
                        width: '100%', height: '100%',
                        background: '#333',
                        borderRadius: 3, overflow: 'hidden', position: 'relative',
                        border: `1px solid ${C.borderInfo}`,
                        boxShadow: '0 8px 40px rgba(0,0,0,.3)',
                      }}>
                        <div style={{
                          position:'absolute', top:0, left:0, right:0,
                          height: `${(1 - frac) * 100}%`,
                          background: '#1a1210',
                          transition: 'height .25s',
                        }} />
                        <div style={{
                          position:'absolute', bottom:0, left:0, right:0,
                          height: `${frac * 100}%`,
                          background: '#f3ead6',
                          transition: 'height .25s',
                        }} />
                        {evalInfo && evalInfo.fen === currentFen && (
                          <div style={{
                            position:'absolute', left:0, right:0, textAlign:'center',
                            ...mono, fontSize: 10, fontWeight: 700,
                            ...(showAtBottom
                              ? { bottom: 4, color: '#1a1a1a' }
                              : { top: 4, color: '#f3ead6' }
                            ),
                          }}>
                            {formatEval(evalInfo)}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>

            {/* Feedback strip — sólo en modo juego (para exploring toda
                la info ya está en el analysis rail arriba, sidebar tiene
                el eval, y no hay más nada debajo del board). */}
            {!isExploring && (
              <div style={{ marginTop:10, padding:'8px 14px', borderRadius:10, minHeight:40, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12,
                background: feedback === 'wrong-flash' ? C.redBg : feedback === 'solved' ? C.correctBg : 'transparent',
                color:      feedback === 'wrong-flash' ? C.red   : feedback === 'solved' ? C.correct   : C.muted,
                fontSize:13,
              }}>
                <span>
                  {feedback === 'solved'       ? '¡Bien!'
                   : feedback === 'wrong-flash' ? 'Incorrecto'
                   : feedback === 'thinking'   ? 'El rival responde...'
                   : `${currentTurn === 'white' ? 'Blancas' : 'Negras'} juegan`}
                </span>
              </div>
            )}
          </div>

          {/* Side panel — cambia según el modo:
              - Solving: card "Sesión · +N puzzles" (progreso)
              - Exploring: Motor + eval bar + Ver solución + Reiniciar
                (todo lo de análisis vive acá; nada abajo del board) */}
          <div style={{ flex: desktop ? '0 0 220px' : '1 1 auto', width: desktop ? undefined : '100%', display:'flex', flexDirection:'column', gap:10 }}>
            {(() => {
              // En retry: card específico (no mostramos tiempos del ciclo).
              if (retryOnly) {
                return (
                  <div style={{ background:C.surface, border:`1px solid ${C.borderInfo}`, borderRadius:12, padding:'14px 16px', textAlign:'center' }}>
                    <div style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.info, marginBottom:4 }}>Reintentando</div>
                    <div style={{ ...mono, fontSize:22, fontWeight:700, color:C.info }}>{queueIdx + 1}/{queue.length}</div>
                    <div style={{ ...mono, fontSize:10, color:C.muted, marginTop:2 }}>errores</div>
                  </div>
                )
              }
              // Card de tiempos — mismo layout en solving y exploring, con
              // indicador ⏸ pausado en exploring. Los valores mismos se
              // congelan automáticamente porque:
              //   - liveMs=0 cuando feedback no es idle/thinking/wrong-flash
              //   - nowTick deja de tickear en exploring (useEffect corta el interval)
              const liveMs = feedback === 'idle' || feedback === 'thinking' || feedback === 'wrong-flash'
                ? nowTick - puzzleStartMs.current
                : 0
              const totalNetMs = cycleAccumulatedMs + liveMs
              const grossMs = cycleStartAt ? (nowTick - cycleStartAt.getTime()) : 0
              return (
                <div style={{
                  background: isExploring ? C.infoBg : C.surface,
                  border: `1px solid ${isExploring ? C.borderInfo : C.border}`,
                  borderRadius: 12, padding: '14px 16px',
                  transition: 'background .2s, border-color .2s',
                }}>
                  <div style={{ textAlign:'center' }}>
                    <div style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color: isExploring ? C.info : C.muted, marginBottom:4, display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
                      {isExploring && <span style={{ fontSize:11 }}>⏸</span>}
                      {isExploring ? 'Sesión · pausada' : 'Sesión'}
                    </div>
                    <div style={{ ...mono, fontSize:22, fontWeight:700, color: isExploring ? C.info : C.amber }}>+{donePuzzlesInSession}</div>
                    <div style={{ ...mono, fontSize:10, color:C.muted, marginTop:2 }}>puzzles</div>
                  </div>
                  <div style={{ height:1, background: isExploring ? C.borderInfo : C.border, margin:'10px 0' }} />
                  <div style={{ display:'flex', gap:8 }}>
                    <div style={{ flex:1, textAlign:'center' }}>
                      <div style={{ ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginBottom:4 }}>Activo</div>
                      <div style={{ ...mono, fontSize:14, fontWeight:700, color: isExploring ? C.muted : C.text }}>{fmtDuration(totalNetMs)}</div>
                    </div>
                    <div style={{ width:1, background: isExploring ? C.borderInfo : C.border }} />
                    <div style={{ flex:1, textAlign:'center' }}>
                      <div style={{ ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginBottom:4 }}>Total</div>
                      <div style={{ ...mono, fontSize:14, fontWeight:700, color:C.muted }}>{fmtDuration(grossMs)}</div>
                    </div>
                  </div>
                </div>
              )
            })()}
            {isExploring && (
              <>
                <label style={{ background:cardSurface, border:`1px solid ${C.borderInfo}`, borderRadius:10, padding:'10px 14px', display:'flex', alignItems:'center', justifyContent:'space-between', cursor:'pointer' }}>
                  <span style={{ fontSize:12, color:C.text }}>Motor</span>
                  <button onClick={() => setEngineOn(v => !v)}
                    style={{ width:32, height:18, borderRadius:9, background: engineOn ? C.info : 'rgba(255,255,255,0.14)', border:'none', position:'relative', cursor:'pointer', padding:0 }}>
                    <div style={{ position:'absolute', top:2, left: engineOn ? 16 : 2, width:14, height:14, borderRadius:'50%', background:'#fff', transition:'left .15s' }} />
                  </button>
                </label>
                {/* La barra de eval + número vive AFUERA del sidebar,
                    a la izquierda del board. Acá sólo dejamos un mini
                    caption con el depth para info técnica. */}
                {engineOn && evalInfo && evalInfo.fen === currentFen && (
                  <div style={{ ...mono, fontSize:10, color:C.muted, textAlign:'center', padding:'2px 0' }}>
                    Motor · depth {evalInfo.depth}
                  </div>
                )}
                <button onClick={playSolution} disabled={animatingSolution}
                  style={{ padding:'11px', borderRadius:10, background:cardSurface, border:`1px solid ${C.borderInfo}`, color:C.text, fontSize:13, fontWeight:600, fontFamily:'inherit', cursor: animatingSolution ? 'not-allowed' : 'pointer', opacity: animatingSolution ? 0.5 : 1, marginTop:4 }}>
                  {animatingSolution ? 'Mostrando...' : 'Ver solución'}
                </button>
                <button onClick={resetPosition} disabled={animatingSolution}
                  style={{ padding:'11px', borderRadius:10, background:cardSurface, border:`1px solid rgba(255,255,255,0.08)`, color:C.muted, fontSize:13, fontWeight:500, fontFamily:'inherit', cursor: animatingSolution ? 'not-allowed' : 'pointer', opacity: animatingSolution ? 0.5 : 1 }}>
                  Reiniciar posición
                </button>

                {/* Historial de análisis — misma nav que Lichess: navegación
                    lateral + chips SAN clickeables. También shortcuts ←/→. */}
                <div style={{ background:cardSurface, border:`1px solid ${C.borderInfo}`, borderRadius:10, padding:'6px', display:'flex', flexDirection:'column', gap:4, marginTop:4 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:2 }}>
                    <button onClick={goFirst} disabled={!canPrev} title="Inicio"
                      style={{ flex:1, padding:'6px 0', borderRadius:6, background:'transparent', border:'none', color: canPrev ? C.text : C.faint, cursor: canPrev ? 'pointer' : 'default', fontSize:14 }}>⏮</button>
                    <button onClick={goPrev} disabled={!canPrev} title="Atrás (←)"
                      style={{ flex:1, padding:'6px 0', borderRadius:6, background:'transparent', border:'none', color: canPrev ? C.text : C.faint, cursor: canPrev ? 'pointer' : 'default', fontSize:14 }}>◀</button>
                    <button onClick={goNext} disabled={!canNext} title="Adelante (→)"
                      style={{ flex:1, padding:'6px 0', borderRadius:6, background:'transparent', border:'none', color: canNext ? C.text : C.faint, cursor: canNext ? 'pointer' : 'default', fontSize:14 }}>▶</button>
                    <button onClick={goLast} disabled={!canNext} title="Final"
                      style={{ flex:1, padding:'6px 0', borderRadius:6, background:'transparent', border:'none', color: canNext ? C.text : C.faint, cursor: canNext ? 'pointer' : 'default', fontSize:14 }}>⏭</button>
                  </div>
                  {nodes.length > 1 && (
                    <div style={{ display:'flex', flexWrap:'wrap', gap:3, padding:'4px 6px 6px', maxHeight:180, overflowY:'auto' }}>
                      {nodes.slice(1).map((n, i) => {
                        const isCurrent = i + 1 === nodeIdx
                        const moveNumber = Math.floor(i / 2) + 1
                        const isWhite = i % 2 === 0
                        return (
                          <button key={i} onClick={() => goToNode(i + 1)}
                            style={{
                              ...mono, fontSize:11, padding:'2px 6px', borderRadius:4,
                              background: isCurrent ? C.amberBg : 'transparent',
                              border: isCurrent ? `1px solid ${C.borderAm}` : '1px solid transparent',
                              color: isCurrent ? C.amber : C.muted, cursor:'pointer', whiteSpace:'nowrap',
                            }}>
                            {isWhite && `${moveNumber}.`}{n.san}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {nodes.length === 1 && (
                    <div style={{ ...mono, fontSize:10, color:C.faint, padding:'4px 6px 6px', textAlign:'center' }}>Jugá para explorar</div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ══ 6. CycleDoneScreen — resumen del ciclo cerrado ══════════════════════════

function CycleDoneScreen({ setId, cycleClosed, onOverview }: {
  setId: string
  cycleClosed: number
  onOverview: () => void
}) {
  const [stats, setStats] = useState<CycleStats[]>([])
  const [set, setSet] = useState<WoodpeckerSet | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([getAllCycleStats(setId), getSet(setId)]).then(([s, st]) => {
      if (!alive) return
      setStats(s); setSet(st)
    })
    return () => { alive = false }
  }, [setId])

  if (!set) return null
  const cur = stats.find(c => c.cycle === cycleClosed)
  const prev = stats.find(c => c.cycle === cycleClosed - 1)
  const delta = cur && prev ? Math.round(((cur.total_ms - prev.total_ms) / prev.total_ms) * 100) : null
  const errDelta = cur && prev ? cur.errors - prev.errors : null
  const wasSetCompleted = set.status === 'completed'

  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', alignItems:'center', justifyContent:'center', padding:'32px 20px', fontFamily:"'DM Sans',system-ui,sans-serif" }}>
      <div style={{ maxWidth:460, width:'100%', display:'flex', flexDirection:'column', gap:20, alignItems:'center' }}>
        <div style={{ ...cinzel, fontSize:18, fontWeight:700, letterSpacing:3, color:C.text, textAlign:'center' }}>
          {wasSetCompleted ? '¡SET COMPLETADO!' : `CICLO ${cycleClosed} · COMPLETADO`}
        </div>
        <div style={{ ...cinzel, fontSize:70, fontWeight:900, color:C.amber, lineHeight:1 }}>
          {cur ? fmtDurationHuman(cur.total_ms) : '—'}
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:10, width:'100%' }}>
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:'16px', textAlign:'center' }}>
            <div style={{ ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase', color:C.muted }}>Errores</div>
            <div style={{ ...mono, fontSize:28, fontWeight:700, color: cur && cur.errors > 0 ? C.red : C.text, marginTop:6 }}>{cur ? cur.errors : '—'}</div>
            {errDelta !== null && (
              <div style={{ ...mono, fontSize:11, color: errDelta < 0 ? C.correct : errDelta > 0 ? C.red : C.muted, marginTop:4 }}>
                {errDelta === 0 ? 'igual que anterior' : errDelta > 0 ? `+${errDelta} vs anterior` : `${errDelta} vs anterior`}
              </div>
            )}
          </div>
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:'16px', textAlign:'center' }}>
            <div style={{ ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase', color:C.muted }}>Δ vs ciclo anterior</div>
            <div style={{ ...mono, fontSize:22, fontWeight:700, color: delta === null ? C.text : (delta < 0 ? C.correct : C.red), marginTop:6 }}>
              {delta === null ? '—' : (delta > 0 ? `+${delta}%` : `${delta}%`)}
            </div>
          </div>
        </div>
        {!wasSetCompleted && (
          <div style={{ fontSize:12, color:C.muted, textAlign:'center', lineHeight:1.6 }}>
            En el próximo ciclo, tu meta es <span style={{ color:C.amber }}>{cur ? fmtDurationHuman(Math.round(cur.total_ms * (set.time_target_pct / 100))) : '—'}</span>
          </div>
        )}
        <button onClick={onOverview}
          style={{ width:'100%', padding:'14px', borderRadius:10, background:C.amber, border:'none', color:C.bg, fontSize:14, fontWeight:700, fontFamily:'inherit', cursor:'pointer', marginTop:8 }}>
          Volver al set
        </button>
      </div>
    </div>
  )
}

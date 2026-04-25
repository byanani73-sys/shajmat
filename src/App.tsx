import { useState, useEffect, useRef, useCallback } from 'react'
import { Chess } from 'chess.js'
import type { Key } from 'chessground/types'
import { ChessBoard } from './ChessBoard'
import type { User } from '@supabase/supabase-js'
import {
  signInWithGoogle, signInWithEmail, signUpWithEmail, signOut,
  onAuthStateChange, getCurrentUser, buildAuthUser, updateProfile, getProfile,
  startLichessOAuth, handleLichessCallback, fetchLichessAccount,
  type AuthUser,
} from './auth'
import {
  saveSession, saveSessionErrors, getBestScores,
  getDashboardSummary, getDashboardActivity, getDashboardStreak,
  getWeeklyScores, getThemeStats, getAllTimeBests,
  type BestScores, type Mode, type Timeframe as DashboardTimeframe,
  type DashboardSummary, type StreakInfo, type WeeklyScore, type ThemeStats, type AllTimeBest,
} from './sessions'
import { saveFeedback } from './feedback'
import { runOfflineSync, installOnlineSyncListener } from './offlineSync'
import { playCorrect, playWrong, playMove, playWarning, isSoundEnabled, toggleSound } from './sounds'
import { flushPendingSessions, installOnlineOutboxListener } from './offlineOutbox'
import { queuePendingSession } from './offlineDb'
import { PuzzleQueue, NoPuzzlesFoundError, type Puzzle, type PuzzleFilters } from './lichess'
import { THEME_GROUPS, OPENING_GROUPS, ALL_OPENINGS, buildFiltersFromSelection, translateTheme, type ThemeOption } from './themes'

function useIsDesktop() {
  const [desktop, setDesktop] = useState(() => window.innerWidth >= 768)
  useEffect(() => {
    const fn = () => setDesktop(window.innerWidth >= 768)
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [])
  return desktop
}

type AppState = 'init' | 'login' | 'config' | 'preparing' | 'storm' | 'results' | 'review' | 'dashboard'
type Feedback = 'idle' | 'thinking' | 'correct' | 'wrong'
interface HistoryEntry extends Puzzle { result: 'ok' | 'err' }

function computeDests(chess: Chess): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>()
  const moves = chess.moves({ verbose: true })
  for (const m of moves) {
    const arr = dests.get(m.from as Key)
    if (arr) arr.push(m.to as Key)
    else dests.set(m.from as Key, [m.to as Key])
  }
  return dests
}

// Validates a user move against a puzzle's expected move, applying Lichess's rule:
// exact match is always correct; any move that delivers mate is also correct when
// the expected move also delivers mate (mate-in-1 positions have multiple valid mates).
function validateMove(currentFen: string, userMoveUci: string, expectedUci: string): boolean {
  if (userMoveUci.slice(0, 4) === expectedUci.slice(0, 4)) return true

  try {
    const expectedProbe = new Chess(currentFen)
    expectedProbe.move({
      from: expectedUci.slice(0, 2),
      to:   expectedUci.slice(2, 4),
      promotion: expectedUci.length > 4 ? (expectedUci[4] as 'q'|'r'|'b'|'n') : undefined,
    })
    if (!expectedProbe.isCheckmate()) return false

    const userProbe = new Chess(currentFen)
    const m = userProbe.move({
      from: userMoveUci.slice(0, 2),
      to:   userMoveUci.slice(2, 4),
      promotion: (userMoveUci.length > 4 ? userMoveUci[4] : 'q') as 'q'|'r'|'b'|'n',
    })
    return !!m && userProbe.isCheckmate()
  } catch {
    return false
  }
}

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg:        '#0e0d0b',
  surface:   '#1b1915',
  surface2:  '#232018',
  border:    'rgba(255,255,255,0.08)',
  borderAm:  'rgba(193,127,42,0.25)',
  text:      '#f7f4ef',
  muted:     'rgba(247,244,239,0.4)',
  faint:     'rgba(247,244,239,0.15)',
  amber:     '#c17f2a',
  amberBg:   'rgba(193,127,42,0.12)',
  correct:   '#6dbf6d',
  correctBg: 'rgba(109,191,109,0.12)',
  red:       '#e05252',
  redBg:     'rgba(224,82,82,0.1)',
}

// ── REGLA DE CONTRASTE — leer antes de usar colores de texto ──────────────
// C.text    (#f7f4ef)        → texto principal, títulos, valores importantes
// C.muted   (opacity 0.4)   → labels, subtítulos, texto secundario LEGIBLE
//                              usar para: labels de sección, hints, descriptions
// C.faint   (opacity 0.15)  → solo para elementos casi invisibles intencionales
//                              usar ÚNICAMENTE para: IDs de puzzle (#xyz),
//                              marca de agua Shin (ש), easter eggs
//                              NO usar para ningún texto que el usuario deba leer
// ─────────────────────────────────────────────────────────────────────────

const mono   = { fontFamily:"'DM Mono', monospace" }
const cinzel = { fontFamily:"'Cinzel', serif" }
const fmt    = (s: number) => `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`

// ─── Shajmat mark (logo B — tres trazos con curl) ─────────────────────────────
function ShajmatMark({ size = 40, color = C.amber }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={Math.round(size * 90/72)} viewBox="0 0 72 90" fill="none">
      <rect x="10" y="77" width="52" height="4.5" rx="2.25" fill={color}/>
      <path d="M22 77 C22 56, 14 38, 9 26 Q7 18 12 16" stroke={color} strokeWidth="5" strokeLinecap="round"/>
      <line x1="36" y1="77" x2="36" y2="8" stroke={color} strokeWidth="5" strokeLinecap="round"/>
      <path d="M50 77 C50 56, 58 38, 63 26 Q65 18 60 16" stroke={color} strokeWidth="5" strokeLinecap="round"/>
    </svg>
  )
}

// ─── Mode icon — 4×4 chess board with mode-specific highlight pattern ───────
// Storm:    todos los cuadrados levemente brillantes, uno solo en ámbar (instante táctico)
// Streak:   diagonal ascendente abajo-izq → arriba-der, con intensidad decreciente
//           (la racha empieza fuerte y se va estirando)
// Practice: todos los cuadrados apagados, ninguno destacado (sin presión)
function ModeIcon({ mode, size = 44 }: { mode: Mode; size?: number }) {
  const base = mode === 'storm' ? 'rgba(247,244,239,0.10)' : 'rgba(247,244,239,0.07)'
  const cellSize = 8.5
  const gap = 2
  return (
    <svg width={size} height={size} viewBox="0 0 40 40">
      {Array.from({ length: 16 }, (_, i) => {
        const r = Math.floor(i / 4)
        const c = i % 4
        let fill = base
        if (mode === 'storm' && r === 1 && c === 1) fill = C.amber
        if (mode === 'streak') {
          if (r === 3 && c === 0) fill = C.amber                         // base — máximo brillo
          if (r === 2 && c === 1) fill = 'rgba(193,127,42,0.75)'
          if (r === 1 && c === 2) fill = 'rgba(193,127,42,0.5)'
          if (r === 0 && c === 3) fill = 'rgba(193,127,42,0.25)'         // punta — más tenue
        }
        return (
          <rect key={i}
            x={c * (cellSize + gap)}
            y={r * (cellSize + gap)}
            width={cellSize} height={cellSize}
            rx={1.5} fill={fill}
          />
        )
      })}
    </svg>
  )
}

// ─── Section nav icons — 4×4 boards con patrones distintivos ────────────────
type Section = 'train' | 'woodpecker' | 'analysis'

function NavIcon({ section, size = 36 }: { section: Section; size?: number }) {
  const cellSize = 8.5
  const gap = 2
  const baseDim    = 'rgba(247,244,239,0.05)'
  const baseBright = 'rgba(247,244,239,0.10)'

  return (
    <svg width={size} height={size} viewBox="0 0 40 40">
      {Array.from({ length: 16 }, (_, i) => {
        const r = Math.floor(i / 4)
        const c = i % 4
        let fill = baseDim

        if (section === 'train') {
          fill = baseBright
          if (r === 1 && c === 1) fill = C.amber  // un solo cuadrado ámbar
        }

        if (section === 'woodpecker') {
          // Dos columnas (col0 y col2) que se intensifican de arriba hacia abajo
          if (c === 0 || c === 2) {
            const stops = ['rgba(193,127,42,0.20)','rgba(193,127,42,0.40)','rgba(193,127,42,0.65)', C.amber]
            fill = stops[r]
          }
        }

        if (section === 'analysis') {
          const reds: Record<string, string> = {
            '0-0': 'rgba(224,82,82,0.5)',
            '0-3': 'rgba(224,82,82,0.3)',
            '1-2': 'rgba(224,82,82,0.6)',
            '2-1': 'rgba(224,82,82,0.35)',
            '3-2': 'rgba(224,82,82,0.5)',
          }
          fill = reds[`${r}-${c}`] ?? baseDim
        }

        return (
          <rect key={i}
            x={c * (cellSize + gap)}
            y={r * (cellSize + gap)}
            width={cellSize} height={cellSize}
            rx={1.5} fill={fill}
          />
        )
      })}
    </svg>
  )
}

// ─── Easter egg Shin ──────────────────────────────────────────────────────────
function EasterShin() {
  return (
    <span style={{
      ...cinzel, position:'absolute', bottom:16, right:18,
      fontSize:11, color:'rgba(193,127,42,0.18)', userSelect:'none',
      pointerEvents:'none',
    }}>ש</span>
  )
}

function Spinner() {
  return <>
    <div style={{ width:16, height:16, border:`2px solid ${C.surface2}`, borderTopColor:C.amber, borderRadius:'50%', animation:'spin .7s linear infinite', flexShrink:0 }} />
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
  </>
}

// ══ Navegación: Sidebar (desktop), BottomNav (mobile), NavLayout ══════════════

const SECTIONS: { id: Section; label: string; group: 'train' | 'tools' }[] = [
  { id: 'train',      label: 'Entrenar',           group: 'train' },
  { id: 'woodpecker', label: 'Pájaro Carpintero',  group: 'tools' },
  { id: 'analysis',   label: 'Análisis de partidas', group: 'tools' },
]

const SECTION_DESCRIPTIONS: Record<Section, string> = {
  train:      '',
  woodpecker: 'Repetición espaciada de tus puzzles más difíciles. Inspirado en el método del Pájaro Carpintero.',
  analysis:   'Análisis de tus partidas de lichess y detección de tus patrones de error',
}

// Avatar circular con inicial del usuario.
function UserAvatar({ user, size = 32 }: { user?: AuthUser; size?: number }) {
  const initial = (user?.username ?? user?.email ?? '?').charAt(0).toUpperCase()
  return (
    <div style={{
      width:size, height:size, borderRadius:'50%',
      background:C.amberBg, border:`1px solid ${C.borderAm}`,
      display:'flex', alignItems:'center', justifyContent:'center',
      ...cinzel, fontSize:Math.round(size*0.45), fontWeight:700, color:C.amber,
      flexShrink:0,
    }}>{initial}</div>
  )
}

// Sidebar desktop: expanded (220px) o collapsed (56px).
function Sidebar({
  section, onSection, collapsed, user, onLogout,
}: {
  section:Section; onSection:(s:Section)=>void; collapsed:boolean
  user?:AuthUser; onLogout:()=>void
}) {
  const eloFmtLabel = user?.lichessEloFormat
    ? user.lichessEloFormat.charAt(0).toUpperCase() + user.lichessEloFormat.slice(1)
    : null
  const trainItems = SECTIONS.filter(s => s.group === 'train')
  const toolsItems = SECTIONS.filter(s => s.group === 'tools')

  return (
    <aside style={{
      width: collapsed ? 56 : 220, flexShrink:0,
      background:C.surface, borderRight:`1px solid ${C.border}`,
      display:'flex', flexDirection:'column',
      padding: collapsed ? '16px 8px' : '20px 16px',
      gap:18, minHeight:'100vh', boxSizing:'border-box',
    }}>
      {/* Logo */}
      <div style={{ display:'flex', alignItems:'center', gap:10, justifyContent: collapsed ? 'center' : 'flex-start' }}>
        <ShajmatMark size={collapsed ? 28 : 28} />
        {!collapsed && (
          <div style={{ ...cinzel, fontSize:16, fontWeight:700, letterSpacing:3, color:C.text }}>SHAJMAT</div>
        )}
      </div>

      {/* Grupo Entrenar */}
      <div>
        {!collapsed && (
          <div style={{ ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginBottom:8, paddingLeft:6 }}>Entrenar</div>
        )}
        {trainItems.map(it => (
          <SidebarItem key={it.id} item={it} active={section===it.id} collapsed={collapsed} onClick={() => onSection(it.id)} />
        ))}
      </div>

      {/* Grupo Herramientas */}
      <div>
        {!collapsed && (
          <div style={{ ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginBottom:8, paddingLeft:6 }}>Herramientas</div>
        )}
        {toolsItems.map(it => (
          <SidebarItem key={it.id} item={it} active={section===it.id} collapsed={collapsed} pending onClick={() => onSection(it.id)} />
        ))}
      </div>

      {/* Footer: avatar + user info + logout */}
      <div style={{ flex:1 }} />
      {user && (
        <div style={{
          display:'flex', alignItems:'center', gap:10,
          padding: collapsed ? 0 : '10px 8px', borderTop:`1px solid ${C.border}`,
          paddingTop:14, justifyContent: collapsed ? 'center' : 'flex-start',
        }}>
          <UserAvatar user={user} size={collapsed ? 28 : 32} />
          {!collapsed && (
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:12, fontWeight:600, color:C.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {user.username ?? user.email?.split('@')[0]}
              </div>
              {user.lichessElo && eloFmtLabel && (
                <div style={{ ...mono, fontSize:9, color:C.muted, marginTop:2 }}>
                  ELO {eloFmtLabel} · {user.lichessElo}
                </div>
              )}
            </div>
          )}
          {!collapsed && (
            <button onClick={onLogout} title="Salir"
              style={{ background:'none', border:'none', color:C.muted, cursor:'pointer', padding:6, fontSize:14 }}>
              ⎋
            </button>
          )}
        </div>
      )}
    </aside>
  )
}

function SidebarItem({
  item, active, collapsed, pending, onClick,
}: {
  item: { id: Section; label: string }
  active: boolean; collapsed: boolean; pending?: boolean
  onClick: () => void
}) {
  return (
    <button onClick={onClick}
      title={collapsed ? item.label : undefined}
      style={{
        width:'100%', display:'flex', alignItems:'center', gap:10,
        padding: collapsed ? '10px 0' : '10px 8px',
        justifyContent: collapsed ? 'center' : 'flex-start',
        background: active ? 'rgba(193,127,42,0.10)' : 'transparent',
        border:'none', borderRadius:8, cursor:'pointer',
        color: active ? C.amber : 'rgba(247,244,239,0.5)',
        fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500,
        transition:'background .15s', position:'relative',
      }}>
      <div style={{ position:'relative', display:'inline-block', lineHeight:0 }}>
        <NavIcon section={item.id} size={28} />
        {pending && (
          <span style={{
            position:'absolute', top:-2, right:-2,
            width:6, height:6, borderRadius:'50%',
            background:'rgba(255,255,255,0.15)',
          }}/>
        )}
      </div>
      {!collapsed && (
        <span style={{ flex:1, textAlign:'left', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {item.label}
        </span>
      )}
      {!collapsed && pending && (
        <span style={{ ...mono, fontSize:8, letterSpacing:1, color:C.muted, padding:'2px 6px', background:'rgba(255,255,255,0.05)', borderRadius:4 }}>
          PRONTO
        </span>
      )}
    </button>
  )
}

// Bottom nav mobile: 3 items con label
function BottomNav({ section, onSection }: { section:Section; onSection:(s:Section)=>void }) {
  return (
    <nav style={{
      position:'fixed', left:0, right:0, bottom:0, zIndex:50,
      background:C.surface, borderTop:`1px solid ${C.border}`,
      display:'flex', justifyContent:'space-around', alignItems:'center',
      padding:'6px 8px 10px', boxSizing:'border-box',
    }}>
      {SECTIONS.map(s => {
        const active  = section === s.id
        const pending = s.group === 'tools'
        return (
          <button key={s.id} onClick={() => onSection(s.id)}
            style={{
              flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:2,
              background:'transparent', border:'none', cursor:'pointer',
              padding:'4px 0',
            }}>
            <div style={{
              position:'relative', padding:6, borderRadius:8,
              background: active ? 'rgba(193,127,42,0.12)' : 'transparent',
              transition:'background .15s', lineHeight:0,
            }}>
              <NavIcon section={s.id} size={26} />
              {pending && (
                <span style={{
                  position:'absolute', top:2, right:2,
                  width:5, height:5, borderRadius:'50%',
                  background:'rgba(255,255,255,0.15)',
                }}/>
              )}
            </div>
            <span style={{
              ...mono, fontSize:8, letterSpacing:1,
              color: active ? C.amber : 'rgba(247,244,239,0.3)',
              textTransform:'uppercase', textAlign:'center',
            }}>
              {s.id === 'train' ? 'Entrenar' : s.id === 'woodpecker' ? 'Carpintero' : 'Análisis'}
            </span>
          </button>
        )
      })}
    </nav>
  )
}

// NavLayout: wrapper que decide sidebar/bottom nav según viewport y variant.
//
// Desktop:
//   expanded  → sidebar 220px
//   collapsed → sidebar 56px (durante el juego)
//   hidden    → sin nav
// Mobile:
//   expanded  → bottom nav fijo abajo
//   collapsed → bottom nav OCULTO (durante el juego, para maximizar el área de juego)
//   hidden    → sin nav
function NavLayout({
  section, onSection, variant, user, onLogout, children,
}: {
  section:Section; onSection:(s:Section)=>void
  variant:'expanded'|'collapsed'|'hidden'
  user?:AuthUser; onLogout:()=>void
  children: React.ReactNode
}) {
  const desktop = useIsDesktop()
  if (variant === 'hidden') return <>{children}</>
  if (desktop) {
    return (
      <div style={{ display:'flex', minHeight:'100vh', background:C.bg }}>
        <Sidebar section={section} onSection={onSection} collapsed={variant==='collapsed'} user={user} onLogout={onLogout} />
        <div style={{ flex:1, minWidth:0 }}>{children}</div>
      </div>
    )
  }
  // Mobile: bottom nav solo cuando expanded (no durante el juego)
  const showBottom = variant === 'expanded'
  return (
    <div style={{ minHeight:'100vh', background:C.bg, paddingBottom: showBottom ? 72 : 0 }}>
      {children}
      {showBottom && <BottomNav section={section} onSection={onSection} />}
    </div>
  )
}

// Pantalla genérica "Próximamente" para Pájaro Carpintero y Análisis
function ComingSoonScreen({ section }: { section: Section }) {
  const title = section === 'woodpecker' ? 'Pájaro Carpintero' : 'Análisis de partidas'
  const desc  = SECTION_DESCRIPTIONS[section]
  return (
    <div style={{
      minHeight:'100vh', display:'flex', flexDirection:'column',
      alignItems:'center', justifyContent:'center', padding:'40px 24px',
      fontFamily:"'DM Sans',system-ui,sans-serif",
    }}>
      <div style={{ maxWidth:360, textAlign:'center' }}>
        <div style={{ marginBottom:18, display:'flex', justifyContent:'center' }}>
          <NavIcon section={section} size={72} />
        </div>
        <div style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.amber, marginBottom:8 }}>
          Próximamente
        </div>
        <h1 style={{ ...cinzel, fontSize:28, fontWeight:700, color:C.text, margin:'0 0 16px', letterSpacing:1 }}>
          {title}
        </h1>
        <p style={{ fontSize:14, color:C.muted, lineHeight:1.6, margin:0 }}>{desc}</p>
      </div>
    </div>
  )
}

// ══ Dashboard ═════════════════════════════════════════════════════════════════
//
// Pantalla de progreso del usuario. Solo se muestra a usuarios autenticados;
// para guests se muestra un overlay invitando a crear cuenta.
// El selector de timeframe arriba (1M/3M/6M/1A/Todo) afecta a todas las
// secciones excepto "Mejores scores" (que es always-time).

const TF_OPTIONS: { id: DashboardTimeframe; label: string }[] = [
  { id: '1m',  label: '1M' },
  { id: '3m',  label: '3M' },
  { id: '6m',  label: '6M' },
  { id: '1y',  label: '1A' },
  { id: 'all', label: 'Todo' },
]

function fmtRelativeDate(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const days = Math.floor(ms / (24*60*60*1000))
  if (days < 1)  return 'hoy'
  if (days < 2)  return 'ayer'
  if (days < 7)  return 'esta semana'
  if (days < 14) return 'la semana pasada'
  if (days < 30) return `hace ${Math.floor(days/7)} semanas`
  if (days < 60) return 'el mes pasado'
  return `hace ${Math.floor(days/30)} meses`
}

function DashboardScreen({
  user, isGuest, onBack, onGoLogin,
}: {
  user?: AuthUser; isGuest: boolean
  onBack: () => void
  onGoLogin: () => void
}) {
  const desktop = useIsDesktop()
  const [tf, setTf] = useState<DashboardTimeframe>('1m')
  const [scoreMode, setScoreMode] = useState<Mode>('storm')

  const [summary,  setSummary]  = useState<DashboardSummary | null>(null)
  const [streak,   setStreak]   = useState<StreakInfo | null>(null)
  const [activity, setActivity] = useState<Map<string, number>>(new Map())
  const [weekly,   setWeekly]   = useState<WeeklyScore[]>([])
  const [themes,   setThemes]   = useState<ThemeStats[]>([])
  const [bests,    setBests]    = useState<AllTimeBest[]>([])
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    if (!user || isGuest) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    Promise.all([
      getDashboardSummary(user.id, tf),
      getDashboardStreak(user.id),
      getDashboardActivity(user.id, tf),
      getThemeStats(user.id, tf),
      getAllTimeBests(user.id),
    ]).then(([s, st, act, th, b]) => {
      if (cancelled) return
      setSummary(s); setStreak(st); setActivity(act); setThemes(th); setBests(b)
      setLoading(false)
    }).catch(e => { console.error('dashboard:', e); if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [user?.id, isGuest, tf])

  // Score por semana — depende del modo seleccionado adicionalmente
  useEffect(() => {
    if (!user || isGuest) return
    let cancelled = false
    getWeeklyScores(user.id, scoreMode, tf).then(w => { if (!cancelled) setWeekly(w) })
    return () => { cancelled = true }
  }, [user?.id, isGuest, tf, scoreMode])

  // Heatmap de actividad: cuántas semanas mostrar según timeframe
  const weeksToShow = tf === '1m' ? 5 : tf === '3m' ? 13 : tf === '6m' ? 26 : tf === '1y' ? 52 : 13
  const heatmapDays = weeksToShow * 7

  return (
    <div style={{
      minHeight:'100vh', background:C.bg,
      padding: desktop ? '32px 40px' : '20px 16px',
      fontFamily:"'DM Sans',system-ui,sans-serif",
      position:'relative',
    }}>
      <div style={{ maxWidth:840, margin:'0 auto' }}>
        {/* Header con back */}
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:24 }}>
          <button onClick={onBack}
            style={{ ...mono, fontSize:11, color:C.muted, background:'none', border:`1px solid ${C.border}`, borderRadius:8, padding:'6px 12px', cursor:'pointer', letterSpacing:1 }}>
            ← Volver
          </button>
          <h1 style={{ ...cinzel, fontSize:22, fontWeight:700, color:C.text, margin:0, letterSpacing:2 }}>Mi progreso</h1>
        </div>

        {/* Timeframe selector */}
        <div style={{ display:'flex', gap:6, marginBottom:24, flexWrap:'wrap' }}>
          {TF_OPTIONS.map(o => {
            const sel = tf === o.id
            return (
              <button key={o.id} onClick={() => setTf(o.id)}
                style={{
                  ...mono, fontSize:11, fontWeight:600, letterSpacing:1,
                  padding:'6px 14px', borderRadius:18,
                  border:`1px solid ${sel ? C.amber : C.border}`,
                  background: sel ? C.amberBg : C.surface,
                  color: sel ? C.amber : C.muted,
                  cursor:'pointer', transition:'all .15s',
                }}>
                {o.label}
              </button>
            )
          })}
        </div>

        {/* Guest overlay */}
        {(!user || isGuest) && (
          <div style={{
            position:'relative', border:`1px solid ${C.border}`, background:C.surface,
            borderRadius:14, padding:'40px 24px', textAlign:'center',
          }}>
            <div style={{ fontSize:15, color:C.text, marginBottom:14, fontWeight:500 }}>
              Creá una cuenta para ver tu progreso
            </div>
            <div style={{ fontSize:12, color:C.muted, marginBottom:20, lineHeight:1.5 }}>
              Las estadísticas se generan a partir de tu historial de sesiones. Necesitás iniciar sesión.
            </div>
            <button onClick={onGoLogin}
              style={{ padding:'12px 22px', borderRadius:10, background:C.amber, border:'none', color:C.bg, fontFamily:"'DM Sans',sans-serif", fontSize:14, fontWeight:700, cursor:'pointer' }}>
              Iniciar sesión
            </button>
          </div>
        )}

        {loading && user && !isGuest && (
          <div style={{ padding:'40px 0', textAlign:'center', display:'flex', alignItems:'center', justifyContent:'center', gap:10 }}>
            <Spinner />
            <span style={{ ...mono, fontSize:11, color:C.muted }}>Cargando...</span>
          </div>
        )}

        {!loading && user && !isGuest && (<>

          {/* 1. Resumen */}
          <DashboardSection title="Resumen">
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
              {[
                { label:'Sesiones',  value: summary?.sessions ?? 0,                       color:C.text },
                { label:'Puzzles',   value: summary?.puzzles  ?? 0,                       color:C.text },
                { label:'Precisión', value: `${Math.round(summary?.accuracy ?? 0)}%`,    color:C.amber },
              ].map(s => (
                <div key={s.label} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:'16px 12px', textAlign:'center' }}>
                  <div style={{ ...mono, fontSize: desktop ? 28 : 22, fontWeight:700, color:s.color, lineHeight:1 }}>{s.value}</div>
                  <div style={{ ...mono, fontSize:8, letterSpacing:2, color:C.muted, marginTop:6, textTransform:'uppercase' }}>{s.label}</div>
                </div>
              ))}
            </div>
          </DashboardSection>

          {/* 2. Racha */}
          <DashboardSection title="Racha">
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:32, flexWrap:'wrap' }}>
                <div>
                  <div style={{ ...cinzel, fontSize:48, fontWeight:700, color:C.amber, lineHeight:1 }}>
                    {streak?.current ?? 0}
                  </div>
                  <div style={{ ...mono, fontSize:9, letterSpacing:2, color:C.muted, marginTop:6, textTransform:'uppercase' }}>
                    Días seguidos
                  </div>
                </div>
                <div style={{ width:1, height:48, background:'rgba(255,255,255,0.08)' }} />
                <div>
                  <div style={{ ...cinzel, fontSize:32, fontWeight:600, color:C.muted, lineHeight:1 }}>
                    {streak?.longest ?? 0}
                  </div>
                  <div style={{ ...mono, fontSize:9, letterSpacing:2, color:C.muted, marginTop:6, textTransform:'uppercase' }}>
                    Mejor racha
                  </div>
                </div>
              </div>
              {streak?.lastSessionAt && (
                <>
                  <div style={{ height:1, background:'rgba(255,255,255,0.06)', margin:'14px 0' }} />
                  <div style={{ ...mono, fontSize:11, color:C.muted, letterSpacing:0.5 }}>
                    Última sesión: {fmtRelativeDate(streak.lastSessionAt)}
                  </div>
                </>
              )}
            </div>
          </DashboardSection>

          {/* 3. Calendario */}
          <DashboardSection title="Actividad">
            <ActivityHeatmap days={heatmapDays} activity={activity} />
            <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:12, ...mono, fontSize:9, color:C.muted, letterSpacing:1 }}>
              Menos
              {[
                'rgba(255,255,255,0.04)',
                'rgba(193,127,42,0.35)',
                'rgba(193,127,42,0.6)',
                'rgba(193,127,42,0.85)',
                C.amber,
              ].map((c, i) => (
                <span key={i} style={{ width:10, height:10, background:c, borderRadius:2, display:'inline-block' }}/>
              ))}
              Más
            </div>
          </DashboardSection>

          {/* 4. Progreso de score (solo Storm y Streak — Práctica no es competitivo) */}
          <DashboardSection title="Progreso">
            <div style={{ display:'flex', gap:6, marginBottom:14, flexWrap:'wrap' }}>
              {(['storm','streak'] as Mode[]).map(m => {
                const sel = scoreMode === m
                const lbl = m === 'storm' ? 'Storm' : 'Streak'
                return (
                  <button key={m} onClick={() => setScoreMode(m)}
                    style={{
                      ...mono, fontSize:10, letterSpacing:1, fontWeight:600,
                      padding:'6px 14px', borderRadius:16,
                      border:`1px solid ${sel ? C.amber : C.border}`,
                      background: sel ? C.amberBg : C.surface,
                      color: sel ? C.amber : C.muted, cursor:'pointer',
                    }}>{lbl}</button>
                )
              })}
            </div>
            {weekly.length < 5 ? (
              <div style={{
                background:C.surface, border:`1px solid ${C.border}`, borderRadius:12,
                padding:'24px 20px', textAlign:'center', color:C.muted, fontSize:12, lineHeight:1.5,
              }}>
                Completá {Math.max(0, 5 - weekly.length)} sesiones más de {scoreMode === 'storm' ? 'Storm' : 'Streak'} para ver tu curva de progreso.
              </div>
            ) : (
              <ScoreChart weekly={weekly} />
            )}
          </DashboardSection>

          {/* 5. Temas */}
          <DashboardSection title="Temas">
            {themes.length < 3 ? (
              <div style={{
                background:C.surface, border:`1px solid ${C.border}`, borderRadius:12,
                padding:'24px 20px', textAlign:'center', color:C.muted, fontSize:12, lineHeight:1.5,
              }}>
                Con 10+ sesiones aparece tu análisis táctico.
              </div>
            ) : (
              <ThemeBreakdown themes={themes} />
            )}
          </DashboardSection>

          {/* 6. Mejores scores all-time */}
          <DashboardSection title="Mejores scores">
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
              {(['storm','streak','practice'] as Mode[]).map(m => {
                const b = bests.find(x => x.mode === m)
                const lbl = m === 'storm' ? 'Storm' : m === 'streak' ? 'Streak' : 'Práctica'
                const has = b && b.best_score > 0
                return (
                  <div key={m} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:'14px 12px', textAlign:'center' }}>
                    <div style={{ ...mono, fontSize:8, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginBottom:6 }}>{lbl}</div>
                    <div style={{ ...mono, fontSize:24, fontWeight:700, color: has ? C.amber : C.text, opacity: has ? 1 : 0.3, lineHeight:1 }}>
                      {has ? b!.best_score : '—'}
                    </div>
                    {has && (
                      <div style={{ ...mono, fontSize:8, color:C.muted, marginTop:6, letterSpacing:1 }}>
                        {fmtRelativeDate(b!.best_date)}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </DashboardSection>
        </>)}
      </div>
    </div>
  )
}

function DashboardSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom:28 }}>
      <div style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.muted, marginBottom:10 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

// ── Activity heatmap ───────────────────────────────────────────────────────
// CSS grid: columnas = semanas (auto-flow), filas = días (Lun→Dom).
// Las celdas escalan a fr para llenar el ancho del card.
function ActivityHeatmap({ days, activity }: { days: number; activity: Map<string, number> }) {
  const ms = 24*60*60*1000
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const weeksToShow = Math.max(1, Math.ceil(days / 7))

  // Lunes de la semana actual = hoy menos (días desde lunes)
  const todayDow = today.getUTCDay()              // 0=Dom .. 6=Sab
  const daysFromMonday = (todayDow + 6) % 7       // 0=Lun .. 6=Dom
  const thisMonday  = new Date(today.getTime() - daysFromMonday * ms)
  const firstMonday = new Date(thisMonday.getTime() - (weeksToShow - 1) * 7 * ms)

  // Generar todas las celdas en orden COLUMNAR (recorre columna por columna)
  // para que con grid-auto-flow: column queden alineadas correctamente.
  const cells: Array<{ date: string; count: number; future: boolean }> = []
  for (let w = 0; w < weeksToShow; w++) {
    for (let d = 0; d < 7; d++) {
      const date   = new Date(firstMonday.getTime() + (w * 7 + d) * ms)
      const dStr   = date.toISOString().split('T')[0]
      const future = date.getTime() > today.getTime()
      cells.push({ date: dStr, count: activity.get(dStr) ?? 0, future })
    }
  }

  const colorFor = (n: number, future: boolean) => {
    if (future)   return 'transparent'
    if (n === 0)  return 'rgba(255,255,255,0.05)'
    if (n === 1)  return 'rgba(193,127,42,0.35)'
    if (n === 2)  return 'rgba(193,127,42,0.6)'
    if (n === 3)  return 'rgba(193,127,42,0.85)'
    return C.amber
  }

  // Labels: Lun, _, Mié, _, Vie, _, Dom (impares + extremos)
  const dowLabels = ['Lun', '', 'Mié', '', 'Vie', '', 'Dom']

  return (
    <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:16, display:'flex', gap:8, alignItems:'stretch' }}>
      {/* Etiquetas de día de la semana */}
      <div style={{
        display:'grid', gridTemplateRows:'repeat(7, 1fr)', gap:3,
        ...mono, fontSize:9, color:C.muted, letterSpacing:0.5,
      }}>
        {dowLabels.map((l, i) => (
          <div key={i} style={{ display:'flex', alignItems:'center', minHeight:12 }}>{l}</div>
        ))}
      </div>
      {/* Grid de celdas: 7 filas × N columnas, cada columna toma 1fr del ancho */}
      <div style={{
        flex:1, minWidth:0,
        display:'grid',
        gridAutoFlow:'column',
        gridTemplateRows:'repeat(7, 1fr)',
        gridAutoColumns:'1fr',
        gap:3,
      }}>
        {cells.map(c => (
          <div key={c.date}
            title={c.future ? '' : `${c.date} · ${c.count} sesion${c.count !== 1 ? 'es' : ''}`}
            style={{
              minHeight:12, borderRadius:2, background: colorFor(c.count, c.future),
            }}
          />
        ))}
      </div>
    </div>
  )
}

// ── Score chart — mejor score por semana ────────────────────────────────────
// Cada barra muestra su valor numérico encima. La última barra con datos se
// destaca en ámbar pleno; las demás en ámbar atenuado.
function ScoreChart({ weekly }: { weekly: WeeklyScore[] }) {
  const max = Math.max(...weekly.map(w => w.best_score), 1)
  // Encontrar índice de la última semana con score > 0 (la más reciente con datos reales)
  let lastWithData = -1
  for (let i = weekly.length - 1; i >= 0; i--) {
    if (weekly[i].best_score > 0) { lastWithData = i; break }
  }

  return (
    <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:16 }}>
      <div style={{ display:'flex', alignItems:'flex-end', gap:6, height:160 }}>
        {weekly.map((w, i) => {
          const h    = (w.best_score / max) * 100
          const last = i === lastWithData
          const has  = w.best_score > 0
          return (
            <div key={w.week} title={`${w.week} · mejor ${w.best_score} (${w.count} sesion${w.count !== 1 ? 'es' : ''})`}
              style={{ flex:1, display:'flex', flexDirection:'column', justifyContent:'flex-end', alignItems:'center', minWidth:0 }}>
              <div style={{ ...mono, fontSize:9, color:'rgba(247,244,239,0.5)', marginBottom:4, height:11 }}>
                {has ? w.best_score : ''}
              </div>
              <div style={{
                width:'100%', maxWidth:32,
                height: has ? `${h}%` : 0, minHeight: has ? 2 : 0,
                background: last ? C.amber : 'rgba(193,127,42,0.3)',
                borderRadius:'3px 3px 0 0', transition:'height .2s',
              }} />
            </div>
          )
        })}
      </div>
      <div style={{ ...mono, fontSize:9, letterSpacing:1, color:C.muted, marginTop:10, textAlign:'center' }}>
        Mejor score por semana · {weekly.length} semana{weekly.length !== 1 ? 's' : ''}
      </div>
    </div>
  )
}

// ── Theme breakdown (fortalezas + a mejorar) ───────────────────────────────
function ThemeBreakdown({ themes }: { themes: ThemeStats[] }) {
  // Top 3 por accuracy (fortalezas), bottom 3 (a mejorar)
  const sorted = [...themes].sort((a, b) => b.accuracy - a.accuracy)
  const strong = sorted.slice(0, 3)
  const weak   = sorted.slice(-3).reverse()

  const Bar = ({ label, accuracy, color }: { label: string; accuracy: number; color: string }) => (
    <div style={{ marginBottom:10 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
        <span style={{ fontSize:13, color:C.text }}>{label}</span>
        <span style={{ ...mono, fontSize:11, color:C.muted, letterSpacing:1 }}>{Math.round(accuracy)}%</span>
      </div>
      <div style={{ height:6, background:C.surface, borderRadius:3, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${accuracy}%`, background:color, borderRadius:3, transition:'width .3s' }} />
      </div>
    </div>
  )

  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:24 }}>
      <div>
        <div style={{ ...mono, fontSize:8, letterSpacing:2, color:C.muted, marginBottom:10, textTransform:'uppercase' }}>Fortalezas</div>
        {strong.map(t => <Bar key={t.theme} label={translateTheme(t.theme)} accuracy={t.accuracy} color={C.correct} />)}
      </div>
      <div>
        <div style={{ ...mono, fontSize:8, letterSpacing:2, color:C.muted, marginBottom:10, textTransform:'uppercase' }}>A mejorar</div>
        {weak.map(t => <Bar key={t.theme} label={translateTheme(t.theme)} accuracy={t.accuracy} color="rgba(224,82,82,0.7)" />)}
      </div>
    </div>
  )
}

// ══ Login ═════════════════════════════════════════════════════════════════════
function LoginScreen({ onGuest }: { onGuest:()=>void }) {
  const [mode,     setMode]     = useState<'main'|'email-login'|'email-signup'>('main')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState<string|null>(null)
  const [error,    setError]    = useState<string|null>(null)
  const [notice,   setNotice]   = useState<string|null>(null)

  const handleGoogle = async () => {
    setLoading('google'); setError(null)
    try { await signInWithGoogle() }
    catch { setError('No se pudo conectar con Google.'); setLoading(null) }
  }

  const handleEmailLogin = async () => {
    if (!email || !password) { setError('Completá todos los campos'); return }
    setLoading('email'); setError(null)
    try { await signInWithEmail(email, password) }
    catch (e: any) {
      setError(e.message?.includes('Invalid') ? 'Email o contraseña incorrectos.' : (e.message ?? 'Error al iniciar sesión.'))
      setLoading(null)
    }
  }

  const handleEmailSignup = async () => {
    if (!email || !password) { setError('Completá todos los campos'); return }
    if (password.length < 8) { setError('La contraseña debe tener al menos 8 caracteres'); return }
    setLoading('email'); setError(null)
    try {
      await signUpWithEmail(email, password)
      setNotice('¡Cuenta creada! Revisá tu email para confirmar.')
      setMode('main')
    }
    catch (e: any) {
      setError(e.message?.includes('already') ? 'Ya existe una cuenta con ese email.' : (e.message ?? 'Error al crear cuenta.'))
      setLoading(null)
    }
  }

  const inputStyle: React.CSSProperties = {
    width:'100%', padding:'12px 14px', borderRadius:10,
    border:`1.5px solid ${C.border}`, background:C.surface,
    fontFamily:"'DM Sans',sans-serif", fontSize:13, color:C.text,
    outline:'none', boxSizing:'border-box',
  }
  const btnPrimary: React.CSSProperties = {
    width:'100%', padding:'14px', borderRadius:10, background:C.amber,
    border:'none', color:C.bg, fontFamily:"'DM Sans',sans-serif",
    fontSize:14, fontWeight:700, cursor:loading?'wait':'pointer',
    opacity:loading?0.8:1, display:'flex', alignItems:'center',
    justifyContent:'center', gap:10,
  }
  const btnSecondary: React.CSSProperties = {
    width:'100%', padding:'13px', borderRadius:10, background:C.surface,
    border:`1px solid ${C.border}`, color:C.text, fontFamily:"'DM Sans',sans-serif",
    fontSize:14, fontWeight:500, cursor:loading?'wait':'pointer',
    opacity:loading?0.8:1, display:'flex', alignItems:'center',
    justifyContent:'center', gap:10,
  }

  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'40px 24px', fontFamily:"'DM Sans',system-ui,sans-serif", position:'relative' }}>
      <EasterShin />
      <div style={{ width:'100%', maxWidth:320 }}>

        {/* Mark + wordmark */}
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:12, marginBottom:40 }}>
          <ShajmatMark size={56} />
          <div style={{ ...cinzel, fontSize:30, fontWeight:700, letterSpacing:6, color:C.text }}>SHAJMAT</div>
          <div style={{ ...mono, fontSize:10, letterSpacing:4, textTransform:'uppercase', color:C.amber, whiteSpace:'nowrap' }}>Táctica · precisión · golpe final</div>
        </div>

        {notice && (
          <div style={{ padding:'12px 14px', borderRadius:10, background:'rgba(109,191,109,0.12)', border:`1px solid ${C.correct}30`, marginBottom:16 }}>
            <p style={{ fontSize:13, color:C.correct, margin:0 }}>{notice}</p>
          </div>
        )}

        {mode === 'main' && <>
          {/* Google */}
          <button onClick={handleGoogle} disabled={!!loading} style={btnSecondary}>
            {loading==='google' ? <Spinner /> : (
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
            )}
            Continuar con Google
          </button>

          <div style={{ display:'flex', alignItems:'center', gap:12, margin:'16px 0' }}>
            <div style={{ flex:1, height:1, background:'rgba(255,255,255,0.15)' }} />
            <span style={{ ...mono, fontSize:9, color:C.muted, letterSpacing:2 }}>O</span>
            <div style={{ flex:1, height:1, background:'rgba(255,255,255,0.15)' }} />
          </div>

          {/* Email */}
          <button onClick={() => { setMode('email-login'); setError(null) }} disabled={!!loading}
            style={{ ...btnSecondary, marginBottom:8 }}>
            Continuar con email
          </button>
          <button onClick={() => { setMode('email-signup'); setError(null) }} disabled={!!loading}
            style={{ ...btnSecondary, background:'transparent', color:C.muted, marginBottom:20 }}>
            Crear cuenta
          </button>

          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
            <div style={{ flex:1, height:1, background:'rgba(255,255,255,0.15)' }} />
            <span style={{ ...mono, fontSize:9, color:C.muted, letterSpacing:2 }}>O</span>
            <div style={{ flex:1, height:1, background:'rgba(255,255,255,0.15)' }} />
          </div>

          <button onClick={onGuest}
            style={{ width:'100%', padding:'13px', borderRadius:10, background:'transparent', border:`1px solid ${C.border}`, color:C.muted, fontFamily:"'DM Sans',sans-serif", fontSize:14, cursor:'pointer' }}>
            Jugar sin cuenta
          </button>
          <div style={{ ...mono, fontSize:10, color:C.muted, textAlign:'center', marginTop:6 }}>Sin historial · sin ELO</div>
        </>}

        {(mode === 'email-login' || mode === 'email-signup') && <>
          <div style={{ ...mono, fontSize:10, letterSpacing:3, textTransform:'uppercase', color:C.amber, marginBottom:20 }}>
            {mode === 'email-login' ? 'Iniciar sesión' : 'Crear cuenta'}
          </div>

          <input type="email" placeholder="tu@email.com" value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key==='Enter' && (mode==='email-login' ? handleEmailLogin() : handleEmailSignup())}
            style={{ ...inputStyle, marginBottom:8 }} />

          <input type="password" placeholder="Contraseña" value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key==='Enter' && (mode==='email-login' ? handleEmailLogin() : handleEmailSignup())}
            style={{ ...inputStyle, marginBottom:16 }} />

          <button disabled={!!loading}
            onClick={mode==='email-login' ? handleEmailLogin : handleEmailSignup}
            style={{ ...btnPrimary, marginBottom:10 }}>
            {loading==='email' && <Spinner />}
            {loading==='email' ? 'Cargando...' : (mode==='email-login' ? 'Iniciar sesión' : 'Crear cuenta')}
          </button>

          <button onClick={() => { setMode('main'); setError(null); setEmail(''); setPassword('') }}
            style={{ width:'100%', padding:'10px', background:'transparent', border:'none', color:C.muted, fontFamily:"'DM Sans',sans-serif", fontSize:13, cursor:'pointer' }}>
            ← Volver
          </button>
        </>}

        {error && (
          <div style={{ marginTop:14, padding:'10px 14px', borderRadius:8, background:C.redBg, border:`1px solid ${C.red}30` }}>
            <p style={{ fontSize:12, color:C.red, margin:0 }}>{error}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ══ Config ════════════════════════════════════════════════════════════════════
function ThemeModal({ selectedThemes, setSelectedThemes, selectedOpenings, setSelectedOpenings, onClose }: {
  selectedThemes: string[]; setSelectedThemes: (s: string[]) => void
  selectedOpenings: string[]; setSelectedOpenings: (s: string[]) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const q = search.trim()

  const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const nq = normalize(q)
  const matches = (opt: ThemeOption) => {
    if (!nq) return true
    const target = normalize(opt.label) + ' ' + normalize(opt.id.replace(/_/g, ' '))
    return target.includes(nq)
  }

  const toggleTheme = (id: string) => {
    if (selectedThemes.includes(id)) setSelectedThemes(selectedThemes.filter(t => t !== id))
    else setSelectedThemes([...selectedThemes, id])
  }
  const toggleOpening = (id: string) => {
    if (selectedOpenings.includes(id)) setSelectedOpenings(selectedOpenings.filter(t => t !== id))
    else setSelectedOpenings([...selectedOpenings, id])
  }
  const clearAll = () => { setSelectedThemes([]); setSelectedOpenings([]) }

  const totalSelected = selectedThemes.length + selectedOpenings.length

  // Filtrar grupos de temas
  const filteredThemeGroups = THEME_GROUPS
    .map(g => ({ ...g, themes: g.themes.filter(matches) }))
    .filter(g => g.themes.length > 0)

  // Filtrar grupos de aperturas
  const filteredOpeningGroups = OPENING_GROUPS
    .map(g => ({ ...g, openings: g.openings.filter(matches) }))
    .filter(g => g.openings.length > 0)

  const hasAnyResults = filteredThemeGroups.length > 0 || filteredOpeningGroups.length > 0

  const chipStyle = (sel: boolean): React.CSSProperties => ({
    padding:'6px 12px', borderRadius:16,
    border:`1px solid ${sel ? C.amber : C.border}`,
    background:sel ? C.amberBg : C.bg,
    fontSize:12, fontWeight:500,
    color:sel ? C.amber : C.muted,
    cursor:'pointer', transition:'all .1s',
    fontFamily:"'DM Sans',sans-serif",
    display:'inline-flex', alignItems:'center', gap:6,
  })

  return (
    <div style={{ position:'fixed', inset:0, zIndex:100, display:'flex', alignItems:'center', justifyContent:'center', padding:24 }}
      onClick={onClose}>
      <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.7)' }} />
      <div style={{ position:'relative', zIndex:1, background:C.surface, border:`1px solid ${C.border}`, borderRadius:16, width:'100%', maxWidth:640, maxHeight:'85vh', display:'flex', flexDirection:'column', overflow:'hidden' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding:'18px 24px', borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
            <div>
              <div style={{ fontSize:15, fontWeight:600, color:C.text }}>Filtrar puzzles</div>
              {totalSelected > 0 && (
                <button onClick={clearAll} style={{ ...mono, fontSize:10, color:C.muted, background:'none', border:'none', cursor:'pointer', padding:0, marginTop:2 }}>
                  Limpiar selección ({totalSelected}) ×
                </button>
              )}
            </div>
            <button onClick={onClose} style={{ width:32, height:32, borderRadius:'50%', background:C.surface2, border:`1px solid ${C.border}`, color:C.muted, cursor:'pointer', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>
          </div>
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Buscar tema o apertura..."
            style={{ width:'100%', padding:'10px 14px', borderRadius:10, border:`1px solid ${C.border}`, background:C.bg, fontFamily:"'DM Sans',sans-serif", fontSize:13, color:C.text, outline:'none', boxSizing:'border-box' }}
          />
        </div>

        {/* Body */}
        <div style={{ overflowY:'auto', padding:'20px 24px' }}>
          {!hasAnyResults && (
            <div style={{ ...mono, fontSize:11, color:C.muted, textAlign:'center', padding:'32px 0' }}>
              Sin resultados para "{q}"
            </div>
          )}

          {/* Grupos de temas */}
          {filteredThemeGroups.length > 0 && (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(240px, 1fr))', gap:'20px 32px', alignContent:'start', marginBottom: filteredOpeningGroups.length > 0 ? 28 : 0 }}>
              {filteredThemeGroups.map(g => (
                <div key={g.name}>
                  <p style={{ ...mono, fontSize:9, letterSpacing:3, color:C.muted, textTransform:'uppercase', marginBottom:10, fontWeight:500 }}>{g.name}</p>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                    {g.themes.map(t => {
                      const sel = selectedThemes.includes(t.id)
                      return (
                        <button key={t.id} onClick={() => toggleTheme(t.id)} style={chipStyle(sel)}>
                          {t.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Separador visual entre temas y aperturas */}
          {filteredThemeGroups.length > 0 && filteredOpeningGroups.length > 0 && (
            <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:22, marginTop:6 }}>
              <p style={{ ...mono, fontSize:10, letterSpacing:3, color:C.amber, textTransform:'uppercase', marginBottom:16, fontWeight:600 }}>Aperturas</p>
            </div>
          )}

          {/* Grupos de aperturas */}
          {filteredOpeningGroups.length > 0 && (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(240px, 1fr))', gap:'20px 32px', alignContent:'start' }}>
              {filteredOpeningGroups.map(g => (
                <div key={g.name}>
                  <p style={{ ...mono, fontSize:9, letterSpacing:3, color:C.muted, textTransform:'uppercase', marginBottom:10, fontWeight:500 }}>{g.name}</p>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                    {g.openings.map(op => {
                      const sel = selectedOpenings.includes(op.id)
                      const low = (op.count ?? 0) < 50
                      return (
                        <button key={op.id} onClick={() => toggleOpening(op.id)} style={chipStyle(sel)}>
                          {op.label}
                          {op.count !== undefined && (
                            <span style={{ ...mono, fontSize:9, color:sel ? C.amber : C.muted, opacity: low ? 0.7 : 1 }}>
                              {op.count}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding:'16px 24px', borderTop:`1px solid ${C.border}`, flexShrink:0 }}>
          <button onClick={onClose} style={{ width:'100%', padding:'13px', borderRadius:10, background:C.amber, border:'none', color:C.bg, fontFamily:"'DM Sans',sans-serif", fontSize:14, fontWeight:700, cursor:'pointer' }}>
            {totalSelected > 0 ? `Confirmar (${totalSelected} filtro${totalSelected>1?'s':''})` : 'Confirmar · sin filtros'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Range slider ───────────────────────────────────────────────────────────
function RangeSlider({ min, max, minValue, maxValue, step = 100, onChange }: {
  min: number; max: number; minValue: number; maxValue: number; step?: number
  onChange: (lo: number, hi: number) => void
}) {
  const range = max - min
  const loPct = ((minValue - min) / range) * 100
  const hiPct = ((maxValue - min) / range) * 100

  const handleLo = (v: number) => {
    const newLo = Math.min(v, maxValue - step)
    onChange(newLo, maxValue)
  }
  const handleHi = (v: number) => {
    const newHi = Math.max(v, minValue + step)
    onChange(minValue, newHi)
  }

  return (
    <div style={{ position:'relative', height:36, paddingTop:12 }}>
      {/* Track */}
      <div style={{ position:'absolute', left:0, right:0, top:'50%', height:3, background:C.surface2, borderRadius:2, transform:'translateY(-50%)' }} />
      {/* Active range */}
      <div style={{ position:'absolute', top:'50%', height:3, background:C.amber, borderRadius:2, transform:'translateY(-50%)', left:`${loPct}%`, width:`${hiPct - loPct}%` }} />
      {/* Two range inputs stacked */}
      <input type="range" min={min} max={max} step={step} value={minValue} onChange={e => handleLo(Number(e.target.value))}
        style={{ position:'absolute', left:0, right:0, top:0, width:'100%', background:'transparent', pointerEvents:'none', appearance:'none', WebkitAppearance:'none', height:36 }}
        className="shajmat-range" />
      <input type="range" min={min} max={max} step={step} value={maxValue} onChange={e => handleHi(Number(e.target.value))}
        style={{ position:'absolute', left:0, right:0, top:0, width:'100%', background:'transparent', pointerEvents:'none', appearance:'none', WebkitAppearance:'none', height:36 }}
        className="shajmat-range" />
      <style>{`
        .shajmat-range::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none;
          width: 20px; height: 20px; border-radius: 50%;
          background: ${C.amber}; border: 2px solid ${C.bg};
          cursor: pointer; pointer-events: auto;
          box-shadow: 0 2px 6px rgba(0,0,0,.4);
        }
        .shajmat-range::-moz-range-thumb {
          width: 20px; height: 20px; border-radius: 50%;
          background: ${C.amber}; border: 2px solid ${C.bg};
          cursor: pointer; pointer-events: auto;
        }
        .shajmat-range::-webkit-slider-runnable-track {
          background: transparent; border: none;
        }
        .shajmat-range::-moz-range-track {
          background: transparent; border: none;
        }
      `}</style>
    </div>
  )
}

// ── Feedback modal (bottom sheet) ───────────────────────────────────────────
function FeedbackModal({ userId, onClose }: { userId?: string; onClose: () => void }) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sent,    setSent]    = useState(false)
  const [error,   setError]   = useState<string|null>(null)

  const handleSubmit = async () => {
    if (!message.trim() || sending) return
    setSending(true); setError(null)
    const ok = await saveFeedback(message, userId)
    setSending(false)
    if (!ok) { setError('No se pudo enviar. Probá de nuevo.'); return }
    setSent(true)
    setTimeout(onClose, 2000)
  }

  return (
    <div onClick={onClose}
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', display:'flex', alignItems:'flex-end', zIndex:200 }}>
      <div onClick={e => e.stopPropagation()}
        style={{
          background:C.surface, width:'100%', maxWidth:480, margin:'0 auto',
          borderRadius:'16px 16px 0 0', padding:'14px 24px 24px',
          maxHeight:'90vh', overflowY:'auto',
          animation:'shajmat-slideup .25s ease-out',
        }}>
        {/* Handle */}
        <div style={{ width:36, height:3, background:'rgba(255,255,255,0.15)', borderRadius:2, margin:'0 auto 18px' }} />

        {/* Creador */}
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:14 }}>
          <div style={{
            width:40, height:40, borderRadius:'50%',
            background:C.amberBg, border:`1px solid ${C.borderAm}`,
            display:'flex', alignItems:'center', justifyContent:'center',
            ...cinzel, fontSize:18, fontWeight:700, color:C.amber,
          }}>B</div>
          <div>
            <div style={{ fontSize:13, fontWeight:600, color:C.text }}>Brian</div>
            <div style={{ ...mono, fontSize:9, letterSpacing:1.5, color:C.muted, textTransform:'uppercase' }}>
              Creador de Shajmat
            </div>
          </div>
        </div>

        {/* Mensaje del creador */}
        <div style={{
          fontSize:13, color:C.muted, lineHeight:1.6,
          borderLeft:`2px solid ${C.borderAm}`, paddingLeft:14, marginBottom:22,
        }}>
          Hice Shajmat porque quería ciertas herramientas para entrenar ajedrez que no
          estaba encontrando. Lichess es increíble, pero no me dejaba filtrar tácticas
          por tema en modo storm/streak. Creo que muchos otros pueden beneficiarse de
          estas herramientas, así que las comparto libremente. Es mi contribución al
          mundo del Ajedrez.
        </div>

        {sent ? (
          <div style={{ padding:'24px 0', textAlign:'center', fontSize:14, color:C.correct, fontWeight:500 }}>
            ¡Gracias! Tu mensaje llegó.
          </div>
        ) : (
          <>
            <div style={{ fontSize:16, fontWeight:600, color:C.text, marginBottom:6 }}>¡Ayudame a mejorar Shajmat!</div>
            <div style={{ fontSize:12, color:C.muted, marginBottom:14, lineHeight:1.5 }}>
              ¿Te gustó la app? ¿Viste algo que podría estar mejor? ¿Hay alguna funcionalidad que
              te gustaría tener? Cada mensaje llega directo a mí.
            </div>
            <textarea value={message} onChange={e => setMessage(e.target.value)}
              placeholder="Escribí lo que pienses..." rows={4}
              style={{
                width:'100%', boxSizing:'border-box', padding:'12px 14px', borderRadius:10,
                background:C.bg, border:`1px solid ${C.border}`, color:C.text,
                fontFamily:"'DM Sans',sans-serif", fontSize:13, outline:'none',
                resize:'vertical', marginBottom:14,
              }} />
            {error && <div style={{ fontSize:11, color:C.red, marginBottom:10 }}>{error}</div>}
            <button onClick={handleSubmit} disabled={sending || !message.trim()}
              style={{
                width:'100%', padding:14, borderRadius:10, background:C.amber, color:C.bg, border:'none',
                fontFamily:"'DM Sans',sans-serif", fontSize:14, fontWeight:700,
                cursor:(sending || !message.trim()) ? 'not-allowed' : 'pointer',
                opacity:(sending || !message.trim()) ? 0.5 : 1, marginBottom:8,
              }}>
              {sending ? 'Enviando...' : 'Enviar feedback'}
            </button>
            <button onClick={onClose}
              style={{ width:'100%', padding:12, background:'transparent', border:'none', color:C.muted, fontFamily:"'DM Sans',sans-serif", fontSize:13, cursor:'pointer' }}>
              Cerrar
            </button>
          </>
        )}
        <style>{`@keyframes shajmat-slideup{from{transform:translateY(100%)}to{transform:translateY(0)}}`}</style>
      </div>
    </div>
  )
}

function ConfigScreen({ user, isGuest, isOnline, mode, setMode, selectedThemes, setSelectedThemes, selectedOpenings, setSelectedOpenings, minRating, maxRating, setRatingRange, onStart, onLogout, onConnectLichess, onShowDashboard }: {
  user?:AuthUser; isGuest:boolean; isOnline:boolean
  mode:Mode; setMode:(m:Mode)=>void
  selectedThemes:string[]; setSelectedThemes:(s:string[])=>void
  selectedOpenings:string[]; setSelectedOpenings:(s:string[])=>void
  minRating:number; maxRating:number
  setRatingRange:(lo:number, hi:number)=>void
  onStart:()=>void; onLogout:()=>void
  onConnectLichess:()=>void
  onShowDashboard:()=>void
}) {
  const [showThemes,   setShowThemes]   = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const desktop = useIsDesktop()
  const userElo  = user?.lichessElo
  const username = user?.username ?? user?.email?.split('@')[0]

  const modeLabel    = mode === 'storm' ? 'Storm' : mode === 'streak' ? 'Streak' : 'Práctica'
  const startLabel   = mode === 'storm' ? 'Iniciar Storm' : mode === 'streak' ? 'Iniciar Streak' : 'Empezar práctica'
  const modeDesc: Record<Mode, string> = {
    storm:    '3 min · contra el reloj',
    streak:   'Sin tiempo · hasta que cometas un error',
    practice: 'Sin tiempo · sin penalidad',
  }

  const presets = [
    { label: 'Fácil',    lo: 600,  hi: 1200 },
    { label: 'Medio',    lo: 1200, hi: 1800 },
    { label: 'Difícil',  lo: 1800, hi: 2400 },
    { label: 'Experto',  lo: 2200, hi: 3000 },
  ]
  if (userElo) {
    presets.splice(2, 0, { label: 'Mi nivel', lo: Math.max(400, userElo - 200), hi: Math.min(3000, userElo + 200) })
  }

  const isPresetActive = (p: {lo:number, hi:number}) => p.lo === minRating && p.hi === maxRating

  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'40px 24px', fontFamily:"'DM Sans',system-ui,sans-serif", position:'relative' }}>
      {showThemes && <ThemeModal selectedThemes={selectedThemes} setSelectedThemes={setSelectedThemes} selectedOpenings={selectedOpenings} setSelectedOpenings={setSelectedOpenings} onClose={() => setShowThemes(false)} />}

      <div style={{ width:'100%', maxWidth: desktop ? 480 : 320 }}>

        {/* Header */}
        <div style={{ marginBottom:32 }}>
          <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:14 }}>
            <ShajmatMark size={36} />
            <div>
              <div style={{ ...cinzel, fontSize:24, fontWeight:700, letterSpacing:4, color:C.text, lineHeight:1 }}>SHAJMAT</div>
              <div style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.amber, marginTop:3 }}>{modeLabel}</div>
            </div>
            {!isOnline && (
              <div style={{ ...mono, fontSize:9, letterSpacing:1, color:C.muted, marginLeft:'auto' }}>
                Sin conexión · puzzles offline
              </div>
            )}
          </div>

          {!isGuest && user && (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                <span style={{ fontSize:13, fontWeight:500, color:C.text }}>{username}</span>
                {userElo
                  ? <span
                      title={user.lichessEloFormat
                        ? `ELO ${user.lichessEloFormat.charAt(0).toUpperCase()}${user.lichessEloFormat.slice(1)} · Lichess`
                        : 'ELO Lichess'}
                      style={{ ...mono, fontSize:10, background:C.amberBg, color:C.amber, padding:'2px 8px', borderRadius:20, border:`1px solid ${C.borderAm}` }}>
                      ♞ {userElo}
                    </span>
                  : <button onClick={onConnectLichess}
                      style={{ ...mono, fontSize:10, color:C.amber, background:C.amberBg, border:`1px solid ${C.borderAm}`, padding:'2px 10px', borderRadius:20, cursor:'pointer' }}>
                      + Conectar Lichess
                    </button>
                }
                <button onClick={onLogout} style={{ fontSize:12, color:C.muted, background:'none', border:'none', cursor:'pointer', marginLeft:'auto' }}>salir</button>
              </div>
              {!userElo && (
                <div style={{ ...mono, fontSize:9, color:C.muted }}>
                  Conectá tu cuenta de Lichess para calibrar los puzzles a tu ELO real
                </div>
              )}
            </div>
          )}
        </div>

        {/* Tabs internas removidas — la sección "Entrenar" ahora es parte
            del nav lateral / inferior. Lo que sigue es solo la pantalla de
            configuración del entrenamiento. */}

        {/* Selector de modo */}
        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:11, fontWeight:500, color:C.muted, letterSpacing:1, marginBottom:10 }}>Modo</div>
          <div style={{ display:'flex', gap:8 }}>
            {(['storm','streak','practice'] as Mode[]).map(m => {
              const active = mode === m
              const label  = m === 'storm' ? 'Storm' : m === 'streak' ? 'Streak' : 'Práctica'
              return (
                <button key={m} onClick={() => setMode(m)}
                  style={{
                    flex:1, padding:'14px 8px', borderRadius:12,
                    border: `1.5px solid ${active ? C.amber : C.border}`,
                    background: active ? C.amberBg : C.surface,
                    cursor:'pointer', transition:'all .15s',
                    display:'flex', flexDirection:'column', alignItems:'center', gap:8,
                    fontFamily:"'DM Sans',sans-serif",
                  }}>
                  <ModeIcon mode={m} size={44} />
                  <div style={{ fontSize:13, fontWeight:600, color: active ? C.amber : C.text }}>{label}</div>
                </button>
              )
            })}
          </div>
          <div style={{ ...mono, fontSize:10, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginTop:10, textAlign:'center' }}>
            {modeDesc[mode]}
          </div>
        </div>

        {/* Rating range */}
        <div style={{ marginBottom:24 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
            <span style={{ fontSize:11, fontWeight:500, color:C.muted, letterSpacing:1 }}>Dificultad</span>
            <span style={{ ...mono, fontSize:12, fontWeight:500, color:C.amber }}>
              ELO {minRating} – {maxRating}
            </span>
          </div>
          {/* Presets */}
          <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginBottom:16 }}>
            {presets.map(p => (
              <button key={p.label} onClick={() => setRatingRange(p.lo, p.hi)}
                style={{ flex:'1 1 auto', padding:'7px 10px', borderRadius:16, fontSize:11, fontWeight:500, cursor:'pointer', border:`1px solid ${isPresetActive(p) ? C.amber : C.border}`, background:isPresetActive(p) ? C.amberBg : C.surface, color:isPresetActive(p) ? C.amber : C.muted, transition:'all .1s' }}>
                {p.label}
              </button>
            ))}
          </div>
          <RangeSlider min={400} max={3000} step={50} minValue={minRating} maxValue={maxRating} onChange={setRatingRange} />
        </div>

        {/* Filtros (temas + aperturas) */}
        <div style={{ marginBottom:32 }}>
          <div style={{ fontSize:11, fontWeight:500, color:C.muted, letterSpacing:1, marginBottom:10 }}>Filtros</div>
          <button onClick={() => setShowThemes(true)}
            style={{ width:'100%', padding:'14px 16px', borderRadius:10, border:`1.5px solid ${(selectedThemes.length + selectedOpenings.length) > 0 ? C.borderAm : C.border}`, background:C.surface, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'space-between', fontFamily:"'DM Sans',sans-serif", transition:'border-color .15s' }}>
            <span style={{ fontSize:13, fontWeight:500, color:(selectedThemes.length + selectedOpenings.length) > 0 ? C.amber : C.muted, textAlign:'left', lineHeight:1.4 }}>
              {(() => {
                const tCount = selectedThemes.length
                const oCount = selectedOpenings.length
                if (tCount === 0 && oCount === 0) return 'Todos los puzzles'

                const parts: string[] = []
                if (tCount > 0) {
                  if (tCount <= 2) {
                    parts.push(selectedThemes.map(id => THEME_GROUPS.flatMap(g=>g.themes).find(t=>t.id===id)?.label ?? id).join(' · '))
                  } else {
                    parts.push(`${tCount} temas`)
                  }
                }
                if (oCount > 0) {
                  if (oCount <= 2) {
                    parts.push(selectedOpenings.map(id => ALL_OPENINGS.find(o=>o.id===id)?.label ?? id).join(' · '))
                  } else {
                    parts.push(`${oCount} aperturas`)
                  }
                }
                return parts.join(' · ')
              })()}
            </span>
            <span style={{ fontSize:13, color:C.muted, marginLeft:8 }}>›</span>
          </button>
        </div>

        <button onClick={onStart}
          style={{ width:'100%', padding:'16px', borderRadius:10, background:C.amber, border:'none', color:C.bg, fontFamily:"'DM Sans',sans-serif", fontSize:15, fontWeight:700, cursor:'pointer' }}>
          {startLabel}
        </button>

        {/* Link al dashboard (solo si hay user logueado, en guest no tiene sentido) */}
        {!isGuest && user && (
          <button onClick={onShowDashboard}
            style={{
              width:'100%', marginTop:14, padding:'12px',
              background:'transparent', border:'none',
              color:C.muted, fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500,
              cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:8,
            }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="8" width="2.5" height="5" rx="0.5" fill="currentColor"/>
              <rect x="5.75" y="5" width="2.5" height="8" rx="0.5" fill="currentColor"/>
              <rect x="10.5" y="2" width="2.5" height="11" rx="0.5" fill="currentColor"/>
            </svg>
            Ver mi progreso
            <span style={{ fontSize:13 }}>›</span>
          </button>
        )}

        {/* Footer */}
        <div style={{
          borderTop:`1px solid ${C.border}`, marginTop:32, paddingTop:18,
          display:'flex', alignItems:'center', justifyContent:'space-between',
        }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ ...cinzel, fontSize:13, color:'rgba(193,127,42,0.18)' }}>ש</span>
            <span style={{ ...mono, fontSize:10, color:C.faint, letterSpacing:1 }}>Shajmat · hecho con ♟</span>
          </div>
          <button onClick={() => setShowFeedback(true)}
            style={{ ...mono, fontSize:11, color:C.muted, background:'none', border:'none', cursor:'pointer', letterSpacing:1, padding:0 }}>
            Feedback →
          </button>
        </div>
      </div>

      {showFeedback && <FeedbackModal userId={user?.id} onClose={() => setShowFeedback(false)} />}
    </div>
  )
}

// ══ Game (Storm / Streak / Práctica) ══════════════════════════════════════════
function GameScreen({ mode, puzzle, currentFen, currentTurn, dests, puzzleNum, minutes, timeLeft, timerStarted, scoreOk, scoreErr, attempts, feedback, loading, error, hintLevel, hintMove, solving, onRetry, onMove, onEnd, onSkip, onHint, onSolution }: {
  mode:Mode
  puzzle:Puzzle|null; currentFen:string; currentTurn:'white'|'black'; dests:Map<Key, Key[]>
  puzzleNum:number; minutes:number; timeLeft:number; timerStarted:boolean
  scoreOk:number; scoreErr:number; attempts:number
  feedback:Feedback; loading:boolean
  error:string|null
  hintLevel:0|1|2; hintMove?:string; solving:boolean
  onRetry:()=>void
  onMove:(o:string,d:string)=>void; onEnd:()=>void
  onSkip:()=>void
  onHint:()=>void; onSolution:()=>void
}) {
  const desktop = useIsDesktop()
  const [soundOn,  setSoundOn]    = useState(() => isSoundEnabled())
  const pct    = Math.round((timeLeft / (minutes*60)) * 100)
  // Aviso de 30s: el timer se pinta rojo en cuanto queden <= 30 segundos.
  const isCrit = timerStarted && timeLeft <= 30 && timeLeft > 0
  const timerColor = isCrit ? C.red : (timerStarted ? C.amber : C.muted)
  const barColor   = isCrit ? C.red : C.amber
  const fbBg   = feedback==='correct' ? C.correctBg : feedback==='wrong' ? C.redBg : 'transparent'
  const fbColor= feedback==='correct' ? C.correct   : feedback==='wrong' ? C.red   : C.muted
  const fbText = feedback==='correct' ? '¡Correcto!'
               : feedback==='wrong'   ? 'Incorrecto'
               : feedback==='thinking'? 'El rival responde...'
               : loading              ? 'Cargando puzzle...'
               : `${currentTurn==='white'?'Blancas':'Negras'} juegan`

  // Tablero siempre en tamaño grande (580px en desktop, full-width en mobile).
  // Antes había un toggle ↗ con overlay; se eliminó porque sumaba un click extra
  // y los usuarios preferían el tablero grande siempre.
  const boardWidth = desktop ? '580px' : undefined
  const boardArea = (
    <div style={{ flex: desktop ? '0 0 auto' : undefined, width: boardWidth ?? '100%' }}>
      {/* Tags */}
      {puzzle && (
        <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginBottom:10 }}>
          <span style={{ fontSize:11, background:C.surface, color:C.muted, padding:'3px 10px', borderRadius:20, border:`1px solid ${C.border}` }}>{puzzle.theme}</span>
          <span style={{ ...mono, fontSize:11, background:C.amberBg, color:C.amber, padding:'3px 10px', borderRadius:20, border:`1px solid ${C.borderAm}` }}>ELO {puzzle.rating}</span>
          <span style={{ fontSize:11, background:C.surface, color:C.muted, padding:'3px 10px', borderRadius:20, border:`1px solid ${C.border}` }}>{currentTurn==='white'?'Blancas':'Negras'} juegan</span>
          <span style={{ ...mono, fontSize:10, background:C.surface, color:C.faint, padding:'3px 10px', borderRadius:20, border:`1px solid ${C.border}` }}>#{puzzle.id}</span>
        </div>
      )}

      {/* Board */}
      <div style={{ position:'relative', borderRadius:8, overflow:'hidden', boxShadow:'0 8px 40px rgba(0,0,0,.5)' }}>
        {error
          ? <div style={{ aspectRatio:'1', background:C.surface, border:`1px solid ${C.red}30`, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:12, padding:24, textAlign:'center' }}>
              <div style={{ fontSize:14, fontWeight:600, color:C.red }}>Sin puzzles disponibles</div>
              <div style={{ fontSize:12, color:C.muted, maxWidth:300, lineHeight:1.5 }}>{error}</div>
              <button onClick={onRetry} style={{ padding:'8px 16px', borderRadius:8, background:C.amber, color:C.bg, border:'none', fontSize:13, fontWeight:600, cursor:'pointer', marginTop:4 }}>Reintentar</button>
            </div>
          : loading && !puzzle
            ? <div style={{ aspectRatio:'1', background:C.surface, display:'flex', alignItems:'center', justifyContent:'center', gap:10 }}><Spinner /><span style={{ ...mono, fontSize:12, color:C.muted }}>Cargando...</span></div>
            : puzzle && currentFen
              ? <ChessBoard key={puzzle.id} fen={currentFen} orientation={puzzle.turn} turn={currentTurn} dests={dests} onMove={onMove} feedback={feedback}
                  wrongRevertDelay={mode === 'practice' ? 1000 : 0}
                  hintLevel={hintLevel} hintMove={hintMove}
                />
              : null
        }
      </div>

      {/* Feedback strip */}
      <div style={{ marginTop:10, padding:fbBg!=='transparent'?'8px 16px':'4px 0', borderRadius:10, background:fbBg, fontSize:13, fontWeight:fbBg!=='transparent'?500:400, color:fbColor, transition:'all .2s', minHeight:36, display:'flex', alignItems:'center', gap:8, justifyContent:'center' }}>
        {loading && feedback==='idle' && <Spinner />}
        {fbText}
      </div>
    </div>
  )

  // ── Top card varies por modo: timer / streak counter / minimal practice ──
  const stormTimerCard = (
    <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding: desktop ? '24px 28px' : '12px 20px' }}>
      <div style={{ ...mono, fontSize: desktop ? 72 : 48, fontWeight:700, letterSpacing:-3, lineHeight:1, color:timerColor, textAlign: desktop ? 'center' : undefined }}>{fmt(timeLeft)}</div>
      <div style={{ height:2, background:C.border, borderRadius:2, marginTop:10, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${pct}%`, background:barColor, borderRadius:2, transition:'width 1s linear' }} />
      </div>
      {desktop && <div style={{ ...mono, fontSize:9, letterSpacing:4, textTransform:'uppercase', color: timerStarted ? C.muted : C.amber, textAlign:'center', marginTop:8 }}>
        {timerStarted ? `STORM · ${minutes} MIN` : 'Jugá para comenzar'}
      </div>}
    </div>
  )

  const streakCard = (
    <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding: desktop ? '28px 28px' : '20px 20px', textAlign:'center' }}>
      <div style={{ ...mono, fontSize:9, letterSpacing:4, textTransform:'uppercase', color:C.muted, marginBottom:8 }}>Racha actual</div>
      <div style={{ ...cinzel, fontSize: desktop ? 80 : 56, fontWeight:900, color:C.amber, lineHeight:1, letterSpacing:-2 }}>{scoreOk}</div>
    </div>
  )

  const practiceCard = (
    <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding: desktop ? '24px 24px' : '16px 20px', textAlign:'center' }}>
      <div style={{ ...mono, fontSize:9, letterSpacing:4, textTransform:'uppercase', color:C.muted, marginBottom:6 }}>Resueltos</div>
      <div style={{ ...mono, fontSize: desktop ? 48 : 36, fontWeight:700, color:C.text, lineHeight:1 }}>{scoreOk}</div>
      {attempts > 0 && (
        <div style={{ ...mono, fontSize:11, letterSpacing:2, textTransform:'uppercase', color:C.amber, marginTop:10 }}>
          Intento {attempts + 1}
        </div>
      )}
    </div>
  )

  const sidePanel = (
    <div style={{ flex:1, display:'flex', flexDirection:'column', gap: desktop ? 20 : 12, minWidth:0 }}>

      {mode === 'storm' && stormTimerCard}
      {mode === 'streak' && streakCard}
      {mode === 'practice' && practiceCard}

      {/* Scores — solo en Storm (correctos vs errores) */}
      {mode === 'storm' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          {[{v:scoreOk,c:C.correct,l:'Correctos'},{v:scoreErr,c:C.red,l:'Errores'}].map(s=>(
            <div key={s.l} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding: desktop ? '20px 16px' : '12px 16px', textAlign:'center' }}>
              <div style={{ ...mono, fontSize: desktop ? 40 : 28, fontWeight:700, color:s.c, lineHeight:1 }}>{s.v}</div>
              <div style={{ ...mono, fontSize:9, letterSpacing:2, color:C.muted, marginTop:6, textTransform:'uppercase' }}>{s.l}</div>
            </div>
          ))}
        </div>
      )}

      {/* Puzzle number */}
      <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:'14px 20px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <span style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.muted }}>Puzzle</span>
        <span style={{ ...mono, fontSize: desktop ? 24 : 18, fontWeight:700, color:C.muted }}>#{puzzleNum}</span>
      </div>

      {/* Botones de práctica: pista, ver solución, siguiente */}
      {mode === 'practice' && (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={onHint} disabled={solving || hintLevel >= 2 || feedback !== 'idle'}
              style={{ flex:1, padding:'12px', borderRadius:10, background:C.surface, border:`1px solid ${C.border}`, color:C.muted, fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500, cursor: (solving || hintLevel >= 2 || feedback !== 'idle') ? 'not-allowed' : 'pointer', opacity: (solving || hintLevel >= 2 || feedback !== 'idle') ? 0.5 : 1 }}>
              {hintLevel === 0 ? 'Pista' : hintLevel === 1 ? 'Otra pista' : 'Sin más pistas'}
            </button>
            <button onClick={onSolution} disabled={solving || feedback !== 'idle'}
              style={{ flex:1, padding:'12px', borderRadius:10, background:C.surface, border:`1px solid ${C.border}`, color:C.muted, fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500, cursor: (solving || feedback !== 'idle') ? 'not-allowed' : 'pointer', opacity: (solving || feedback !== 'idle') ? 0.5 : 1 }}>
              Ver solución
            </button>
          </div>
          <button onClick={onSkip} disabled={solving}
            style={{ width:'100%', padding:'14px', borderRadius:10, background:C.surface, border:`1px solid ${C.border}`, color:C.text, fontFamily:"'DM Sans',sans-serif", fontSize:14, fontWeight:500, cursor: solving ? 'not-allowed' : 'pointer', opacity: solving ? 0.5 : 1 }}>
            Siguiente →
          </button>
        </div>
      )}

      {/* End session — pushed to bottom on desktop */}
      {desktop && <div style={{ flex:1 }} />}
      <button onClick={onEnd} style={{ ...mono, fontSize:10, letterSpacing:2, textTransform:'uppercase', color:C.muted, cursor:'pointer', background:'none', border:'none', paddingTop:4, textAlign:'center' }}>
        Terminar sesión
      </button>
    </div>
  )

  // Botón de toggle de sonido — esquina superior derecha del área de juego, discreto
  const soundToggle = (
    <button
      onClick={() => setSoundOn(toggleSound())}
      title={soundOn ? 'Sonido activado' : 'Sonido desactivado'}
      style={{
        position:'absolute', top: desktop ? 16 : 12, right: desktop ? 16 : 12, zIndex: 5,
        width:32, height:32, borderRadius:8, padding:0, cursor:'pointer',
        background:'transparent', border:`1px solid ${C.border}`,
        color: soundOn ? C.amber : C.muted,
        display:'flex', alignItems:'center', justifyContent:'center',
      }}>
      {soundOn ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M3 6V10H5L8 12.5V3.5L5 6H3Z" fill="currentColor"/>
          <path d="M10.5 5C11.5 5.8 11.5 10.2 10.5 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M3 6V10H5L8 12.5V3.5L5 6H3Z" fill="currentColor"/>
          <line x1="11" y1="5" x2="14" y2="11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          <line x1="14" y1="5" x2="11" y2="11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
      )}
    </button>
  )

  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', flexDirection:'column', alignItems:'center', justifyContent: desktop ? 'center' : 'flex-start', padding: desktop ? '40px 48px' : '16px 16px 24px', fontFamily:"'DM Sans',system-ui,sans-serif", position:'relative' }}>
      {soundToggle}
      <div style={{
        width:'100%',
        maxWidth: desktop ? 940 : 460,
        display:'flex',
        flexDirection: desktop ? 'row' : 'column',
        alignItems: desktop ? 'flex-start' : 'center',
        gap: desktop ? 28 : 12,
      }}>
        {desktop ? <>{boardArea}{sidePanel}</> : <>{sidePanel}{boardArea}</>}
      </div>
    </div>
  )
}

// ══ Results ═══════════════════════════════════════════════════════════════════
// ══ Review (practicar errores, sin timer) ═════════════════════════════════════
function ReviewScreen({ puzzles, idx, onNext, onBack }: {
  puzzles:HistoryEntry[]; idx:number; onNext:()=>void; onBack:()=>void
}) {
  const [currentFen,  setCurrentFen]  = useState('')
  const [currentTurn, setCurrentTurn] = useState<'white'|'black'>('white')
  const [dests,       setDests]       = useState<Map<Key, Key[]>>(new Map())
  const [moveIdx,     setMoveIdx]     = useState(0)
  const [feedback,    setFeedback]    = useState<Feedback>('idle')
  const [wrongHint,   setWrongHint]   = useState<string|null>(null)
  const [attempts,    setAttempts]    = useState(0)
  const chessRef = useRef<Chess|null>(null)
  const advanceRef = useRef<ReturnType<typeof setTimeout>|null>(null)

  const puzzle = puzzles[idx]

  useEffect(() => {
    if (!puzzle) return
    const c = new Chess(puzzle.fen)
    chessRef.current = c
    setCurrentFen(puzzle.fen)
    setCurrentTurn(puzzle.turn)
    setDests(computeDests(c))
    setMoveIdx(0)
    setFeedback('idle')
    setWrongHint(null)
    setAttempts(0)
    return () => { if (advanceRef.current) clearTimeout(advanceRef.current) }
  }, [puzzle?.id])

  const handleMove = useCallback((orig: string, dest: string) => {
    if (feedback !== 'idle' || !puzzle || !chessRef.current) return

    const expected  = puzzle.solution[moveIdx]
    const userMove  = orig + dest
    const isCorrect = validateMove(currentFen, userMove, expected)

    if (!isCorrect) {
      try {
        const probe = new Chess(currentFen)
        const m = probe.move({
          from: expected.slice(0, 2), to: expected.slice(2, 4),
          promotion: expected.length > 4 ? (expected[4] as 'q'|'r'|'b'|'n') : undefined,
        })
        setWrongHint(m?.san ?? expected)
      } catch { setWrongHint(expected) }

      setFeedback('wrong')
      setAttempts(a => a + 1)
      // In review: bounce back, let user keep trying
      advanceRef.current = setTimeout(() => {
        setFeedback('idle')
      }, 1800)
      return
    }

    try {
      chessRef.current.move({
        from: orig, to: dest,
        promotion: 'q', // default; chess.js ignores for non-promotion moves
      })
    } catch { return }

    const nextMoveIdx = moveIdx + 1
    setCurrentFen(chessRef.current.fen())
    setDests(new Map())

    if (nextMoveIdx >= puzzle.solution.length) {
      setFeedback('correct')
      setWrongHint(null)
      advanceRef.current = setTimeout(onNext, 1200)
      return
    }

    setFeedback('thinking')
    setMoveIdx(nextMoveIdx)
    advanceRef.current = setTimeout(() => {
      if (!chessRef.current || !puzzle) return
      const opp = puzzle.solution[nextMoveIdx]
      try {
        chessRef.current.move({
          from: opp.slice(0, 2), to: opp.slice(2, 4),
          promotion: opp.length > 4 ? (opp[4] as 'q'|'r'|'b'|'n') : undefined,
        })
      } catch { return }
      setCurrentFen(chessRef.current.fen())
      setCurrentTurn(chessRef.current.turn() === 'w' ? 'white' : 'black')
      setDests(computeDests(chessRef.current))
      setMoveIdx(nextMoveIdx + 1)
      setFeedback('idle')
    }, 550)
  }, [feedback, puzzle, moveIdx, currentFen, onNext])

  if (!puzzle) return null

  const fbBg    = feedback==='correct' ? C.correctBg : feedback==='wrong' ? C.redBg : 'transparent'
  const fbColor = feedback==='correct' ? C.correct   : feedback==='wrong' ? C.red   : C.muted
  const fbText  = feedback==='correct' ? '¡Resuelto!'
                : feedback==='wrong'   ? (wrongHint ? `Era ${wrongHint} · probá de nuevo` : 'Intentá de nuevo')
                : feedback==='thinking'? 'El rival responde...'
                : `${currentTurn==='white'?'Blancas':'Negras'} juegan`

  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', flexDirection:'column', alignItems:'center', padding:'16px 16px 24px', gap:12, fontFamily:"'DM Sans',system-ui,sans-serif" }}>

      {/* Header */}
      <div style={{ width:'100%', maxWidth:460, display:'flex', alignItems:'center', gap:12 }}>
        <button onClick={onBack} style={{ padding:'8px 12px', borderRadius:8, border:`1px solid ${C.border}`, background:C.surface, fontSize:12, color:C.muted, cursor:'pointer' }}>← Resultados</button>
        <div style={{ flex:1, textAlign:'center' }}>
          <div style={{ fontSize:12, letterSpacing:2, textTransform:'uppercase', color:C.muted, fontWeight:500 }}>Practicar errores</div>
          <div style={{ ...mono, fontSize:18, fontWeight:700, color:C.text, marginTop:2 }}>{idx+1} / {puzzles.length}</div>
        </div>
        <button onClick={onNext} style={{ padding:'8px 12px', borderRadius:8, border:`1px solid ${C.border}`, background:C.surface, fontSize:12, color:C.muted, cursor:'pointer' }}>Saltar →</button>
      </div>

      {/* Tags */}
      <div style={{ width:'100%', maxWidth:460, display:'flex', gap:6, flexWrap:'wrap' }}>
        <span style={{ fontSize:11, background:C.surface, color:C.muted, padding:'3px 10px', borderRadius:20, border:`1px solid ${C.border}`, fontWeight:500 }}>{puzzle.theme}</span>
        <span style={{ ...mono, fontSize:11, background:C.amberBg, color:C.amber, padding:'3px 10px', borderRadius:20, fontWeight:500 }}>ELO {puzzle.rating}</span>
        <span style={{ fontSize:11, background:C.surface, color:C.muted, padding:'3px 10px', borderRadius:20, border:`1px solid ${C.border}`, fontWeight:500 }}>{currentTurn==='white'?'Blancas':'Negras'} juegan</span>
        {attempts > 0 && <span style={{ ...mono, fontSize:11, background:C.redBg, color:C.red, padding:'3px 10px', borderRadius:20, fontWeight:500 }}>{attempts} intento{attempts>1?'s':''}</span>}
      </div>

      {/* Board */}
      <div style={{ width:'100%', maxWidth:460, borderRadius:8, overflow:'hidden', boxShadow:'0 8px 40px rgba(0,0,0,.5)' }}>
        {currentFen && <ChessBoard key={puzzle.id} fen={currentFen} orientation={puzzle.turn} turn={currentTurn} dests={dests} onMove={handleMove} feedback={feedback} showDests />}
      </div>

      {/* Feedback */}
      <div style={{ width:'100%', maxWidth:460, padding:'10px 16px', borderRadius:10, background:fbBg, transition:'background .25s', minHeight:42, display:'flex', alignItems:'center', justifyContent:'center' }}>
        <span style={{ fontSize:13, fontWeight:500, color:fbColor, textAlign:'center' }}>{fbText}</span>
      </div>

    </div>
  )
}


function ResultsScreen({ mode, minutes, scoreOk, scoreErr, history, bestScores, streakBreaker, onRepeat, onReview, onConfig }: {
  mode:Mode
  minutes:number; scoreOk:number; scoreErr:number
  history:HistoryEntry[]; bestScores:BestScores|null
  streakBreaker:HistoryEntry|null
  onRepeat:()=>void; onReview:()=>void; onConfig:()=>void
}) {
  const total = scoreOk + scoreErr, acc = total > 0 ? Math.round((scoreOk/total)*100) : 0
  const wrong = history.filter(h => h.result === 'err')
  const desktop = useIsDesktop()

  const headline = mode === 'storm'  ? `Storm · ${minutes} minuto${minutes>1?'s':''}`
                 : mode === 'streak' ? 'Streak · racha'
                 :                     'Práctica'
  const subLabel = mode === 'streak' ? (scoreOk === 1 ? 'puzzle en la racha' : 'puzzles en la racha')
                 : mode === 'practice' ? 'puzzles resueltos'
                 :                       'puzzles resueltos'
  const repeatLabel = mode === 'storm'  ? 'Repetir Storm'
                    : mode === 'streak' ? 'Nueva racha'
                    :                     'Otra práctica'
  const showBestScores = mode !== 'practice' && bestScores
  const bestLabel = mode === 'streak' ? 'Mejores rachas' : 'Mejores puntajes'

  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'40px 24px', fontFamily:"'DM Sans',system-ui,sans-serif", position:'relative' }}>
      <EasterShin />
      <div style={{ width:'100%', maxWidth: desktop ? 720 : 320 }}>

        {/* Score headline */}
        <div style={{ textAlign:'center', marginBottom:32 }}>
          <div style={{ ...mono, fontSize:9, letterSpacing:5, textTransform:'uppercase', color:C.muted, marginBottom:8 }}>{headline}</div>
          <div style={{ ...cinzel, fontSize: desktop ? 140 : 'clamp(80px,22vw,120px)', fontWeight:900, color:C.amber, lineHeight:1, letterSpacing:-3, marginBottom:4 }}>{scoreOk}</div>
          <div style={{ ...mono, fontSize:10, letterSpacing:4, textTransform:'uppercase', color:C.muted }}>{subLabel}</div>
        </div>

        {/* Stats — Storm muestra correctos/errores/precisión; Streak/Practice solo resueltos/intentos */}
        {mode === 'storm' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom: showBestScores ? 16 : 24 }}>
            {[{l:'Correctos',v:scoreOk,c:C.correct},{l:'Errores',v:scoreErr,c:C.red},{l:'Precisión',v:`${acc}%`,c:C.text}].map(s=>(
              <div key={s.l} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding: desktop ? '20px 12px' : '14px 8px', textAlign:'center' }}>
                <div style={{ ...mono, fontSize: desktop ? 36 : 30, fontWeight:700, color:s.c, lineHeight:1 }}>{s.v}</div>
                <div style={{ ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginTop:6 }}>{s.l}</div>
              </div>
            ))}
          </div>
        )}

        {/* Streak: mostrar el puzzle que cortó la racha */}
        {mode === 'streak' && streakBreaker && (
          <div style={{ background:C.surface, border:`1px solid ${C.red}30`, borderLeft:`3px solid ${C.red}`, borderRadius:12, padding:'14px 18px', marginBottom: showBestScores ? 16 : 24, display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ flex:1 }}>
              <div style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.red, marginBottom:4 }}>Cayó en</div>
              <div style={{ fontSize:14, fontWeight:600, color:C.text }}>{streakBreaker.theme}</div>
              <div style={{ ...mono, fontSize:10, color:C.muted, marginTop:2 }}>#{streakBreaker.id}</div>
            </div>
            <span style={{ ...mono, fontSize:11, background:C.amberBg, color:C.amber, padding:'4px 10px', borderRadius:20, border:`1px solid ${C.borderAm}` }}>ELO {streakBreaker.rating}</span>
          </div>
        )}

        {/* Practice: solo resueltos vs intentos */}
        {mode === 'practice' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8, marginBottom:24 }}>
            {[{l:'Resueltos',v:scoreOk,c:C.correct},{l:'Errores',v:scoreErr,c:C.muted}].map(s=>(
              <div key={s.l} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding: desktop ? '20px 12px' : '14px 8px', textAlign:'center' }}>
                <div style={{ ...mono, fontSize: desktop ? 36 : 30, fontWeight:700, color:s.c, lineHeight:1 }}>{s.v}</div>
                <div style={{ ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginTop:6 }}>{s.l}</div>
              </div>
            ))}
          </div>
        )}

        {/* Mejores puntajes/rachas — solo Storm y Streak con usuario autenticado */}
        {showBestScores && (
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:'16px 20px', marginBottom:24 }}>
            <div style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.muted, marginBottom:12 }}>{bestLabel}</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, textAlign:'center' }}>
              {[
                { l:'Hoy',    v:bestScores!.today },
                { l:'Semana', v:bestScores!.week },
                { l:'Mes',    v:bestScores!.month },
                { l:'Total',  v:bestScores!.allTime },
              ].map(s => (
                <div key={s.l}>
                  <div style={{ ...mono, fontSize: desktop ? 28 : 22, fontWeight:700, color: s.v === scoreOk && s.v !== null ? C.correct : C.text, lineHeight:1 }}>
                    {s.v ?? '—'}
                  </div>
                  <div style={{ ...mono, fontSize:8, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginTop:4 }}>{s.l}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Errors section — Storm muestra; Streak no (ya tiene streakBreaker box); Practice tampoco (no acumula history de errores) */}
        {wrong.length > 0 && mode === 'storm' && (
          <div style={{ display: desktop ? 'grid' : 'block', gridTemplateColumns: desktop ? '1fr 1fr' : undefined, gap: desktop ? 24 : 0, marginBottom:24 }}>
            <div>
              <button onClick={onReview} style={{ width:'100%', padding:'14px 16px', background:C.amberBg, border:`1px solid ${C.borderAm}`, borderRadius:12, marginBottom:16, cursor:'pointer', display:'flex', alignItems:'center', gap:12, textAlign:'left' }}>
                <div style={{ width:36, height:36, borderRadius:'50%', background:C.surface2, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, color:C.amber, flexShrink:0 }}>↻</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:600, color:C.text }}>Practicar errores</div>
                  <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>{wrong.length} puzzle{wrong.length>1?'s':''} · sin apuro de tiempo</div>
                </div>
                <span style={{ fontSize:18, color:C.amber }}>→</span>
              </button>
            </div>
            <div>
              <div style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.muted, marginBottom:8 }}>Puzzles fallados</div>
              {wrong.map((p,i)=>(
                <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 14px', background:C.surface, borderRadius:8, borderLeft:`2px solid ${C.red}`, marginBottom:5 }}>
                  <div>
                    <div style={{ fontSize:12, fontWeight:500, color:C.text }}>{p.theme}</div>
                    <div style={{ ...mono, fontSize:10, color:C.faint, marginTop:2 }}>#{p.id}</div>
                  </div>
                  <span style={{ ...mono, fontSize:10, background:C.surface2, color:C.muted, padding:'2px 8px', borderRadius:20 }}>{p.rating}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {wrong.length===0 && mode !== 'streak' && <div style={{ ...mono, fontSize:11, letterSpacing:2, textTransform:'uppercase', color:C.muted, textAlign:'center', marginBottom:24 }}>Sin errores · sesión perfecta</div>}

        <div style={{ display:'flex', gap:8 }}>
          <button onClick={onConfig} style={{ flex:1, padding:'13px 0', borderRadius:10, border:`1px solid ${C.border}`, background:C.surface, fontSize:13, fontWeight:500, color:C.muted, cursor:'pointer', fontFamily:"'DM Sans',sans-serif" }}>Configurar</button>
          <button onClick={onRepeat} style={{ flex:2, padding:'13px 0', borderRadius:10, background:C.amber, border:'none', color:C.bg, fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:"'DM Sans',sans-serif" }}>{repeatLabel}</button>
        </div>
      </div>
    </div>
  )
}

// ══ Preparing ═════════════════════════════════════════════════════════════════
// Pantalla de carga mientras se preparan los primeros puzzles. El timer del
// Storm no arranca hasta que esto termina, para no "robar" tiempo al usuario.
function PreparingScreen({ mode, error, onCancel, onRetry }: {
  mode: Mode
  error: string | null
  onCancel: () => void
  onRetry: () => void
}) {
  const subtitle = mode === 'storm' ? 'Storm · 3 min' : mode === 'streak' ? 'Streak · sin tiempo' : 'Práctica'
  return (
    <div style={{
      minHeight:'100vh', background:C.bg,
      display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
      padding:'40px 24px', fontFamily:"'DM Sans',system-ui,sans-serif", gap:32,
    }}>
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:14 }}>
        <ShajmatMark size={56} />
        <div style={{ ...cinzel, fontSize:24, fontWeight:700, letterSpacing:5, color:C.text }}>SHAJMAT</div>
        <div style={{ ...mono, fontSize:9, letterSpacing:4, textTransform:'uppercase', color:C.amber }}>
          {subtitle}
        </div>
      </div>

      {error ? (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:14, maxWidth:340, textAlign:'center' }}>
          <div style={{ fontSize:14, fontWeight:600, color:C.red }}>No se pudieron cargar los puzzles</div>
          <div style={{ fontSize:12, color:C.muted, lineHeight:1.5 }}>{error}</div>
          <div style={{ display:'flex', gap:8, marginTop:8 }}>
            <button onClick={onCancel} style={{ padding:'10px 18px', borderRadius:8, border:`1px solid ${C.border}`, background:C.surface, fontSize:13, fontWeight:500, color:C.muted, cursor:'pointer', fontFamily:"'DM Sans',sans-serif" }}>
              Volver a configurar
            </button>
            <button onClick={onRetry} style={{ padding:'10px 18px', borderRadius:8, background:C.amber, border:'none', color:C.bg, fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:"'DM Sans',sans-serif" }}>
              Reintentar
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:16 }}>
          <Spinner />
          <div style={{ ...mono, fontSize:10, letterSpacing:3, textTransform:'uppercase', color:C.muted }}>
            Preparando puzzles...
          </div>
        </div>
      )}
    </div>
  )
}

// ══ Root ══════════════════════════════════════════════════════════════════════
export default function App() {
  const [appState, setAppState] = useState<AppState>('init')
  const [section,  setSection]  = useState<Section>('train')
  const [authUser, setAuthUser] = useState<AuthUser|null>(null)
  const [isGuest,  setIsGuest]  = useState(false)
  const [mode,     setMode]     = useState<Mode>('storm')
  const [selectedThemes,   setSelectedThemes]   = useState<string[]>([])
  const [selectedOpenings, setSelectedOpenings] = useState<string[]>([])
  const [minRating, setMinRating] = useState(1200)
  const [maxRating, setMaxRating] = useState(1800)
  const setRatingRange = useCallback((lo: number, hi: number) => {
    setMinRating(lo); setMaxRating(hi)
  }, [])
  const STORM_MINUTES = 3
  const minutes = STORM_MINUTES  // Storm fijo en 3 min — se mantiene la variable para timer/save

  const [screen,       setScreen]       = useState<'storm'|'results'>('storm')
  const [timeLeft,     setTimeLeft]     = useState(180)
  const [timerStarted, setTimerStarted] = useState(false)
  const [puzzle,      setPuzzle]      = useState<Puzzle|null>(null)
  const [currentFen,  setCurrentFen]  = useState<string>('')
  const [currentTurn, setCurrentTurn] = useState<'white'|'black'>('white')
  const [dests,       setDests]       = useState<Map<Key, Key[]>>(new Map())
  const [moveIdx,     setMoveIdx]     = useState(0)
  const [loading,     setLoading]     = useState(false)
  const [scoreOk,     setScoreOk]     = useState(0)
  const [scoreErr,    setScoreErr]    = useState(0)
  const [feedback,    setFeedback]    = useState<Feedback>('idle')
  const [history,     setHistory]     = useState<HistoryEntry[]>([])
  const [puzzleCount, setPuzzleCount] = useState(0)
  const [fetchError,  setFetchError]  = useState<string|null>(null)
  const [bestScores,  setBestScores]  = useState<BestScores|null>(null)
  const [bestStreaks, setBestStreaks] = useState<BestScores|null>(null)
  const [isOnline,    setIsOnline]    = useState<boolean>(typeof navigator === 'undefined' ? true : navigator.onLine)
  const [attempts,    setAttempts]    = useState(0)
  const [streakBreaker, setStreakBreaker] = useState<HistoryEntry|null>(null)
  const [hintLevel,   setHintLevel]   = useState<0|1|2>(0)
  const [solving,     setSolving]     = useState(false)

  const timerRef    = useRef<ReturnType<typeof setInterval>|null>(null)
  const nextRef     = useRef<ReturnType<typeof setTimeout>|null>(null)
  const queueRef    = useRef<PuzzleQueue|null>(null)
  const chessRef    = useRef<Chess|null>(null)
  const sessionStart = useRef<string>(new Date().toISOString())
  const seenIds      = useRef<string[]>([])
  const endSessRef   = useRef<() => void>(() => {})
  const warnedRef    = useRef(false)  // aviso de 30s — disparar solo una vez por sesión
  const skipPushRef  = useRef(false)  // popstate → no rebobinar el push de history
  const lastStateRef = useRef<AppState>('init')  // para detectar transiciones automáticas

  // Cuando carga un puzzle nuevo, resetear posición
  useEffect(() => {
    if (!puzzle) return
    const c = new Chess(puzzle.fen)
    chessRef.current = c
    setCurrentFen(puzzle.fen)
    setCurrentTurn(puzzle.turn)
    setDests(computeDests(c))
    setMoveIdx(0)
    setAttempts(0)
    setHintLevel(0)
    setSolving(false)
  }, [puzzle?.id])

  // Resetear pista cuando avanza el moveIdx (cada nueva jugada del usuario)
  useEffect(() => { setHintLevel(0) }, [moveIdx])

  // ── Online / offline awareness ───────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onOnline  = () => setIsOnline(true)
    const onOffline = () => setIsOnline(false)
    window.addEventListener('online',  onOnline)
    window.addEventListener('offline', onOffline)
    installOnlineSyncListener()
    installOnlineOutboxListener()
    return () => {
      window.removeEventListener('online',  onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  // ── Botón "atrás" del browser / PWA ─────────────────────────────────────
  // En la PWA Android la flechita de hardware/sistema dispara popstate. Sin
  // pushState propio, eso cierra la app; con esto, navega entre pantallas
  // como dashboard → config, results → config, review → results.
  //
  // Estrategia:
  //  1) Cada vez que appState cambia hacia un estado "profundo" (no config),
  //     pusheamos una entrada nueva en history. Las transiciones automáticas
  //     (preparing→storm→results) usan replaceState para que toda la sesión
  //     ocupe una sola entrada — un solo back para salir.
  //  2) popstate → leemos el appState actual y lo "rebobinamos" al lógico
  //     anterior. Marcamos skipPushRef para que el efecto de push no vuelva
  //     a empujar tras el setAppState.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (skipPushRef.current) {
      skipPushRef.current = false
      lastStateRef.current = appState
      return
    }
    const prev = lastStateRef.current
    lastStateRef.current = appState

    // No tocamos history en estados "raíz"
    if (appState === 'init' || appState === 'login' || appState === 'config') return

    // Transiciones automáticas dentro de una sesión: replace (no agrega entrada)
    const isAutoTransition =
      (prev === 'preparing' && appState === 'storm') ||
      (prev === 'storm'     && appState === 'results')

    if (isAutoTransition) window.history.replaceState({ appState }, '')
    else                  window.history.pushState   ({ appState }, '')
  }, [appState])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPop = () => {
      skipPushRef.current = true
      // Determinar a dónde "volver" según el estado actual
      // (lo capturamos del closure — el listener se re-suscribe por la dep)
      if (appState === 'dashboard') {
        setAppState('config'); setScreen('storm')
      } else if (appState === 'preparing' || appState === 'storm') {
        clearInterval(timerRef.current!); clearTimeout(nextRef.current!)
        setAppState('config'); setScreen('storm')
      } else if (appState === 'results') {
        setAppState('config'); setScreen('storm')
      } else if (appState === 'review') {
        setAppState('results')
      } else {
        // En config/login/init no hacemos nada — el browser ya consumió la
        // entrada y la próxima vez que el usuario presione atrás cierra la app
        skipPushRef.current = false
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [appState])

  // ── Iniciar descarga + flush de sesiones pendientes al llegar al config ──
  // Idempotente: si ya está corriendo o ya terminó la fase A, no duplica.
  // El flush sube cualquier sesión que haya quedado encolada offline.
  useEffect(() => {
    if (appState === 'config') {
      runOfflineSync()
      flushPendingSessions().then(n => {
        if (n > 0) {
          // Refrescar best scores con las sesiones que recién se subieron
          if (authUser) {
            getBestScores(authUser.id, 'storm').then(setBestScores).catch(() => {})
            getBestScores(authUser.id, 'streak').then(setBestStreaks).catch(() => {})
          }
        }
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appState])

  // Init — auth de Supabase con sesión persistente
  useEffect(() => {
    let mounted = true

    const processUser = async (supaUser: User | null) => {
      if (!mounted) return
      if (supaUser) {
        const built = buildAuthUser(supaUser)
        const profile = await getProfile(supaUser.id).catch(() => null)
        if (!mounted) return
        if (profile?.lichess_elo) {
          built.lichessElo       = profile.lichess_elo
          built.lichessEloFormat = profile.lichess_elo_format ?? undefined
          built.lichessId        = profile.lichess_id
          if (profile.username) built.username = profile.username
          setMinRating(Math.max(400, profile.lichess_elo - 200))
          setMaxRating(Math.min(3000, profile.lichess_elo + 200))
        }
        getBestScores(supaUser.id, 'storm').then(s => mounted && setBestScores(s)).catch(() => {})
        getBestScores(supaUser.id, 'streak').then(s => mounted && setBestStreaks(s)).catch(() => {})
        setAuthUser(built)
        setIsGuest(false)
        setAppState('config')
      } else {
        setAuthUser(null)
        setAppState('login')
      }
    }

    // Esperar a que Supabase termine de detectar la sesión (URL hash u localStorage)
    // antes de decidir login vs config. Evita el flash de login en redirects de OAuth.
    getCurrentUser().then(processUser)

    // Suscribirse a cambios futuros: SIGNED_IN tras OAuth, SIGNED_OUT tras logout,
    // TOKEN_REFRESHED. Ignoramos INITIAL_SESSION porque ya lo manejamos arriba.
    const unsub = onAuthStateChange((supaUser, event) => {
      if (event === 'INITIAL_SESSION') return
      processUser(supaUser)
    })

    return () => { mounted = false; unsub() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Storm timer (solo modo Storm). Pausa si la sección activa no es Entrenar
  // (o sea, si el usuario navegó a Pájaro Carpintero / Análisis durante el juego).
  useEffect(() => {
    if (mode !== 'storm' || appState !== 'storm' || screen !== 'storm' || section !== 'train' || !timerStarted) return
    timerRef.current = setInterval(() => {
      setTimeLeft(t => {
        const next = t - 1
        // Aviso de 30 segundos — disparar UNA sola vez por sesión
        if (next === 30 && !warnedRef.current) { warnedRef.current = true; playWarning() }
        if (t <= 1) { clearInterval(timerRef.current!); endSessRef.current(); return 0 }
        return next
      })
    }, 1000)
    return () => clearInterval(timerRef.current!)
  }, [mode, appState, section, screen, timerStarted])

  const loadNext = useCallback(async () => {
    setLoading(true); setFetchError(null)
    try {
      const p = await queueRef.current!.next()
      seenIds.current.push(p.id)
      setPuzzle(p); setFeedback('idle')
    }
    catch (e) {
      if (e instanceof NoPuzzlesFoundError) {
        setFetchError('No hay puzzles con estos filtros. Probá aflojando la selección de temas o el rango de rating.')
      } else {
        setFetchError((e as Error).message)
      }
      setPuzzle(null)
    }
    finally { setLoading(false) }
  }, [])

  const advanceToNext = useCallback(() => {
    setPuzzleCount(c => c + 1)
    nextRef.current = setTimeout(() => loadNext(), 50)
  }, [loadNext])

  const handleMove = useCallback((orig: string, dest: string) => {
    if (feedback !== 'idle' || !puzzle || !chessRef.current || loading || solving) return
    if (mode === 'storm' && !timerStarted) setTimerStarted(true)

    const expected  = puzzle.solution[moveIdx]
    const userMove  = orig + dest
    const isCorrect = validateMove(currentFen, userMove, expected)

    if (!isCorrect) {
      setFeedback('wrong')
      playWrong()
      if (mode === 'storm') {
        setScoreErr(s=>s+1)
        setHistory(h=>[...h, {...puzzle, result:'err'}])
        nextRef.current = setTimeout(advanceToNext, 400)
      } else if (mode === 'streak') {
        // Termina la racha. Animar la jugada correcta y luego ir a resultados.
        setHistory(h=>[...h, {...puzzle, result:'err'}])
        setStreakBreaker({...puzzle, result:'err'})
        nextRef.current = setTimeout(() => {
          if (!chessRef.current || !puzzle) return
          try {
            chessRef.current.move({
              from: expected.slice(0, 2),
              to:   expected.slice(2, 4),
              promotion: expected.length > 4 ? (expected[4] as 'q'|'r'|'b'|'n') : undefined,
            })
            setCurrentFen(chessRef.current.fen())
            setCurrentTurn(chessRef.current.turn() === 'w' ? 'white' : 'black')
            setDests(new Map())
          } catch {}
          nextRef.current = setTimeout(() => endSessRef.current(), 900)
        }, 250)
      } else {
        // practice: reintentar el mismo puzzle (estilo Lichess: pieza queda en cuadro
        // equivocado ~1000ms, después snap-back animado, después libera input)
        setScoreErr(s=>s+1)
        setAttempts(a=>a+1)
        nextRef.current = setTimeout(() => setFeedback('idle'), 1300)
      }
      return
    }

    try {
      chessRef.current.move({ from: orig, to: dest, promotion: 'q' })
    } catch { return }

    const nextMoveIdx = moveIdx + 1
    setCurrentFen(chessRef.current.fen())
    setDests(new Map())

    if (nextMoveIdx >= puzzle.solution.length) {
      setFeedback('correct'); setScoreOk(s=>s+1)
      setHistory(h=>[...h, {...puzzle, result:'ok'}])
      playCorrect()
      // En práctica, esperar a que el usuario haga click en "Siguiente" para avanzar
      if (mode !== 'practice') {
        nextRef.current = setTimeout(advanceToNext, 400)
      }
      return
    }

    setFeedback('thinking')
    setMoveIdx(nextMoveIdx)
    nextRef.current = setTimeout(() => {
      if (!chessRef.current || !puzzle) return
      const opp = puzzle.solution[nextMoveIdx]
      try {
        chessRef.current.move({
          from: opp.slice(0, 2), to: opp.slice(2, 4),
          promotion: opp.length > 4 ? (opp[4] as 'q'|'r'|'b'|'n') : undefined,
        })
      } catch { return }
      setCurrentFen(chessRef.current.fen())
      setCurrentTurn(chessRef.current.turn() === 'w' ? 'white' : 'black')
      setDests(computeDests(chessRef.current))
      setMoveIdx(nextMoveIdx + 1)
      setFeedback('idle')
      playMove()
    }, 300)
  }, [mode, feedback, puzzle, loading, solving, moveIdx, currentFen, advanceToNext, timerStarted])

  const startSession = useCallback(async () => {
    clearInterval(timerRef.current!); clearTimeout(nextRef.current!)
    setTimeLeft(minutes*60); setPuzzleCount(0); setTimerStarted(false)
    setScoreOk(0); setScoreErr(0); setFeedback('idle'); setHistory([])
    setAttempts(0); setStreakBreaker(null); setHintLevel(0); setSolving(false)
    warnedRef.current = false
    seenIds.current = []
    sessionStart.current = new Date().toISOString()
    setScreen('storm')
    setAppState('preparing')
    setPuzzle(null); setFetchError(null); setLoading(true)

    const groups = buildFiltersFromSelection(selectedThemes, selectedOpenings)
    const filters: PuzzleFilters = { ...groups, minRating, maxRating }
    queueRef.current = new PuzzleQueue(filters)

    try {
      const first = await queueRef.current.next()
      seenIds.current.push(first.id)
      setPuzzle(first)
      queueRef.current.fill()
      setAppState('storm')
    } catch (e) {
      if (e instanceof NoPuzzlesFoundError) {
        setFetchError('No hay puzzles con estos filtros. Probá aflojando la selección de temas o el rango de rating.')
      } else {
        setFetchError((e as Error).message)
      }
      setPuzzle(null)
    }
    finally { setLoading(false) }
  }, [minutes, selectedThemes, selectedOpenings, minRating, maxRating])

  // Guardar sesión en Supabase cuando termina (solo usuarios autenticados)
  const endSess = useCallback(async () => {
    clearInterval(timerRef.current!); clearTimeout(nextRef.current!)
    setScreen('results')

    if (authUser && !isGuest) {
      const groups = buildFiltersFromSelection(selectedThemes, selectedOpenings)
      const sessionData = {
        user_id:      authUser.id,
        mode,
        minutes,
        themes:       Object.values(groups).flat().filter(t => !t.includes('_')),
        opening_tags: groups.openingTags ?? [],
        min_rating:   minRating,
        max_rating:   maxRating,
        score_ok:     scoreOk,
        score_err:    scoreErr,
        puzzles_seen: seenIds.current,
        started_at:   sessionStart.current,
      }
      const errIds = history.filter(h => h.result === 'err').map(h => h.id)
      const sessionId = await saveSession(sessionData)

      if (sessionId) {
        if (errIds.length > 0) await saveSessionErrors(sessionId, errIds)
      } else {
        // Falló la subida (probablemente offline). Encolar en el outbox para
        // reintentar cuando vuelva la conexión. saveSession usa upsert con id
        // explícito así que el reintento es idempotente.
        await queuePendingSession(sessionData, errIds)
      }

      // Refrescar mejores scores del modo correspondiente
      if (mode === 'storm')  getBestScores(authUser.id, 'storm').then(setBestScores).catch(() => {})
      if (mode === 'streak') getBestScores(authUser.id, 'streak').then(setBestStreaks).catch(() => {})
    }
  }, [authUser, isGuest, mode, minutes, selectedThemes, selectedOpenings, minRating, maxRating, scoreOk, scoreErr, history])

  // Mantener el ref actualizado para que timer y streak handler puedan llamar endSess
  endSessRef.current = endSess

  // ── Práctica: pistas (1 = pieza, 2 = jugada completa) ───────────────────
  const requestHint = useCallback(() => {
    if (solving || feedback !== 'idle') return
    setHintLevel(l => (l < 2 ? ((l + 1) as 0|1|2) : l))
  }, [solving, feedback])

  // ── Práctica: ver solución completa, animada ──────────────────────────
  const playSolution = useCallback(() => {
    if (solving || !puzzle || !chessRef.current) return
    setSolving(true)
    setFeedback('thinking')
    setDests(new Map())

    let idx = moveIdx
    const playStep = () => {
      if (!chessRef.current || !puzzle) return
      if (idx >= puzzle.solution.length) {
        setFeedback('correct')
        nextRef.current = setTimeout(() => {
          setSolving(false)
          advanceToNext()
        }, 700)
        return
      }
      const m = puzzle.solution[idx]
      try {
        chessRef.current.move({
          from: m.slice(0, 2), to: m.slice(2, 4),
          promotion: m.length > 4 ? (m[4] as 'q'|'r'|'b'|'n') : undefined,
        })
        setCurrentFen(chessRef.current.fen())
        setCurrentTurn(chessRef.current.turn() === 'w' ? 'white' : 'black')
      } catch {}
      idx += 1
      nextRef.current = setTimeout(playStep, 550)
    }
    playStep()
  }, [solving, puzzle, moveIdx, advanceToNext])

  const goConfig = useCallback(() => {
    clearInterval(timerRef.current!); clearTimeout(nextRef.current!)
    setAppState('config'); setScreen('storm')
  }, [])

  const goDashboard = useCallback(() => {
    clearInterval(timerRef.current!); clearTimeout(nextRef.current!)
    setAppState('dashboard'); setScreen('storm')
  }, [])

  // Click en una sección del nav: si es Entrenar, siempre volvemos al config
  // (incluso desde el dashboard o coming-soon). Para Pájaro Carpintero / Análisis
  // solo cambiamos la sección.
  const handleSection = useCallback((s: Section) => {
    if (s === 'train') {
      clearInterval(timerRef.current!); clearTimeout(nextRef.current!)
      setAppState('config'); setScreen('storm')
    }
    setSection(s)
  }, [])

  const logout = useCallback(async () => {
    clearInterval(timerRef.current!); clearTimeout(nextRef.current!)
    await signOut()
    setAuthUser(null); setIsGuest(false)
    setAppState('login')
  }, [])

  const goGuest = useCallback(() => {
    setIsGuest(true); setAppState('config')
  }, [])

  // ── Lichess PKCE: manejar callback en la URL ───────────────────────────
  // Cuando Lichess redirige de vuelta con ?code=... lo procesamos silenciosamente.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code   = params.get('code')
    if (!code || !authUser) return

    // Limpiar la URL sin recargar
    window.history.replaceState({}, '', window.location.pathname)

    async function processLichessCallback() {
      try {
        const token   = await handleLichessCallback(code!)
        const account = await fetchLichessAccount(token)

        // Guardar en perfil de Supabase
        await updateProfile(authUser!.id, {
          lichess_id:         account.id,
          lichess_elo:        account.elo,
          lichess_elo_format: account.eloFormat,
          username:           account.username,
        })

        // Actualizar estado local
        setAuthUser(prev => prev ? {
          ...prev,
          lichessId:        account.id,
          lichessElo:       account.elo,
          lichessEloFormat: account.eloFormat,
          username:         account.username,
        } : prev)

        // Calibrar slider al ELO de Lichess
        if (account.elo) {
          setMinRating(Math.max(400, account.elo - 200))
          setMaxRating(Math.min(3000, account.elo + 200))
        }
      } catch (e) {
        console.error('Error procesando callback de Lichess:', e)
      }
    }

    processLichessCallback()
  }, [authUser?.id]) // solo cuando authUser esté disponible

  const connectLichess = useCallback(async () => {
    try { await startLichessOAuth() }
    catch (e) { console.error('Error iniciando Lichess OAuth:', e) }
  }, [])

  // Review (practicar errores)
  const [reviewIdx, setReviewIdx] = useState(0)
  const reviewPuzzles = history.filter(h => h.result === 'err')
  const startReview = useCallback(() => {
    if (reviewPuzzles.length === 0) return
    setReviewIdx(0); setAppState('review')
  }, [reviewPuzzles.length])
  const nextReview = useCallback(() => {
    setReviewIdx(i => {
      const next = i + 1
      if (next >= reviewPuzzles.length) { setAppState('results'); return 0 }
      return next
    })
  }, [reviewPuzzles.length])
  const backToResults = useCallback(() => setAppState('results'), [])

  if (appState==='init') return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', alignItems:'center', justifyContent:'center', gap:10, fontFamily:"'DM Sans',sans-serif" }}>
      <Spinner /><span style={{ ...mono, fontSize:12, color:C.muted }}>Cargando...</span>
    </div>
  )
  if (appState==='login') return <LoginScreen onGuest={goGuest} />

  // Si la sección activa NO es Entrenar, mostrar la pantalla "Próximamente"
  // del módulo correspondiente (con nav expandido).
  if (section !== 'train') {
    return (
      <NavLayout section={section} onSection={handleSection} variant="expanded" user={authUser ?? undefined} onLogout={logout}>
        <ComingSoonScreen section={section} />
      </NavLayout>
    )
  }

  // Sección Entrenar — variante del nav según el appState. Durante el juego
  // (preparing/storm/review) el nav se contrae en desktop y se oculta en mobile.
  const navVariant: 'expanded'|'collapsed' =
    (appState === 'preparing' || appState === 'storm' || appState === 'review') ? 'collapsed' : 'expanded'

  let inner: React.ReactNode
  if (appState === 'config') {
    inner = (
      <ConfigScreen
        user={authUser??undefined} isGuest={isGuest} isOnline={isOnline}
        mode={mode} setMode={setMode}
        selectedThemes={selectedThemes} setSelectedThemes={setSelectedThemes}
        selectedOpenings={selectedOpenings} setSelectedOpenings={setSelectedOpenings}
        minRating={minRating} maxRating={maxRating} setRatingRange={setRatingRange}
        onStart={startSession} onLogout={logout} onConnectLichess={connectLichess}
        onShowDashboard={goDashboard}
      />
    )
  } else if (appState === 'dashboard') {
    inner = (
      <DashboardScreen
        user={authUser ?? undefined} isGuest={isGuest}
        onBack={goConfig} onGoLogin={() => setAppState('login')}
      />
    )
  } else if (appState === 'preparing') {
    inner = <PreparingScreen mode={mode} error={fetchError} onCancel={goConfig} onRetry={startSession} />
  } else if (appState === 'storm' && screen === 'storm') {
    inner = (
      <GameScreen
        mode={mode}
        puzzle={puzzle} currentFen={currentFen} currentTurn={currentTurn}
        dests={dests} puzzleNum={puzzleCount+1}
        minutes={minutes} timeLeft={timeLeft} timerStarted={timerStarted}
        scoreOk={scoreOk} scoreErr={scoreErr} attempts={attempts}
        feedback={feedback}
        loading={loading} error={fetchError}
        hintLevel={hintLevel}
        hintMove={puzzle?.solution[moveIdx]}
        solving={solving}
        onRetry={loadNext}
        onMove={handleMove} onEnd={endSess} onSkip={advanceToNext}
        onHint={requestHint} onSolution={playSolution}
      />
    )
  } else if (appState === 'review') {
    inner = <ReviewScreen puzzles={reviewPuzzles} idx={reviewIdx} onNext={nextReview} onBack={backToResults} />
  } else {
    // results
    inner = (
      <ResultsScreen
        mode={mode}
        minutes={minutes} scoreOk={scoreOk} scoreErr={scoreErr}
        history={history}
        bestScores={mode === 'streak' ? bestStreaks : bestScores}
        streakBreaker={streakBreaker}
        onRepeat={startSession} onReview={startReview} onConfig={goConfig}
      />
    )
  }

  return (
    <NavLayout section={section} onSection={handleSection} variant={navVariant} user={authUser ?? undefined} onLogout={logout}>
      {inner}
    </NavLayout>
  )
}

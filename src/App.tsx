import { useState, useEffect, useRef, useCallback } from 'react'
import { Chess } from 'chess.js'
import type { Key } from 'chessground/types'
import { ChessBoard } from './ChessBoard'
import {
  signInWithGoogle, signInWithEmail, signUpWithEmail, signOut,
  onAuthStateChange, buildAuthUser, updateProfile, getProfile,
  startLichessOAuth, handleLichessCallback, fetchLichessAccount,
  type AuthUser,
} from './auth'
import { saveSession, saveSessionErrors, getBestScores, type BestScores } from './sessions'
import { PuzzleQueue, NoPuzzlesFoundError, type Puzzle, type PuzzleFilters } from './lichess'
import { THEME_GROUPS, OPENING_GROUPS, ALL_OPENINGS, buildFiltersFromSelection, type ThemeOption } from './themes'

function useIsDesktop() {
  const [desktop, setDesktop] = useState(() => window.innerWidth >= 768)
  useEffect(() => {
    const fn = () => setDesktop(window.innerWidth >= 768)
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [])
  return desktop
}

type AppState = 'init' | 'login' | 'config' | 'preparing' | 'storm' | 'results' | 'review'
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
    if (password.length < 6) { setError('La contraseña debe tener al menos 6 caracteres'); return }
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
          <div style={{ ...mono, fontSize:10, letterSpacing:4, textTransform:'uppercase', color:C.amber }}>Táctica · precisión · golpe final</div>
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

function ConfigScreen({ user, isGuest, minutes, setMinutes, selectedThemes, setSelectedThemes, selectedOpenings, setSelectedOpenings, minRating, maxRating, setRatingRange, onStart, onLogout, onConnectLichess }: {
  user?:AuthUser; isGuest:boolean; minutes:number
  setMinutes:(m:number)=>void
  selectedThemes:string[]; setSelectedThemes:(s:string[])=>void
  selectedOpenings:string[]; setSelectedOpenings:(s:string[])=>void
  minRating:number; maxRating:number
  setRatingRange:(lo:number, hi:number)=>void
  onStart:()=>void; onLogout:()=>void
  onConnectLichess:()=>void
}) {
  const [showThemes, setShowThemes] = useState(false)
  const desktop = useIsDesktop()
  const userElo  = user?.lichessElo
  const username = user?.username ?? user?.email?.split('@')[0]

  const pillOn  = { border:`1.5px solid ${C.amber}`, background:C.amberBg, color:C.amber }
  const pillOff = { border:`1.5px solid ${C.border}`, background:C.surface, color:C.muted }
  const btnBase: React.CSSProperties = { flex:1, height:48, borderRadius:10, textAlign:'center', cursor:'pointer', border:'none', transition:'all .15s' }

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
              <div style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.amber, marginTop:3 }}>Storm</div>
            </div>
          </div>

          {!isGuest && user && (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                <span style={{ fontSize:13, fontWeight:500, color:C.text }}>{username}</span>
                {userElo
                  ? <span style={{ ...mono, fontSize:10, background:C.amberBg, color:C.amber, padding:'2px 8px', borderRadius:20, border:`1px solid ${C.borderAm}` }}>
                      ♞ Lichess {userElo}
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
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:11, fontWeight:500, color:C.muted, letterSpacing:1, marginBottom:10 }}>Duración</div>
          <div style={{ display:'flex', gap:8 }}>
            {[3,5,10].map(m => (
              <button key={m} onClick={() => setMinutes(m)}
                style={{ ...btnBase, ...(minutes===m ? pillOn : pillOff), ...mono, fontWeight:700, fontSize:22 }}>
                {m}<span style={{ fontSize:11, fontWeight:400, marginLeft:2 }}>m</span>
              </button>
            ))}
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
          Iniciar Storm
        </button>
      </div>
    </div>
  )
}

// ══ Storm ═════════════════════════════════════════════════════════════════════
function StormScreen({ puzzle, currentFen, currentTurn, dests, puzzleNum, minutes, timeLeft, timerStarted, scoreOk, scoreErr, feedback, loading, error, onRetry, onMove, onEnd }: {
  puzzle:Puzzle|null; currentFen:string; currentTurn:'white'|'black'; dests:Map<Key, Key[]>
  puzzleNum:number; minutes:number; timeLeft:number; timerStarted:boolean
  scoreOk:number; scoreErr:number; feedback:Feedback; loading:boolean
  error:string|null; onRetry:()=>void
  onMove:(o:string,d:string)=>void; onEnd:()=>void
}) {
  const desktop = useIsDesktop()
  const pct    = Math.round((timeLeft / (minutes*60)) * 100)
  const isCrit = timerStarted && timeLeft < 30
  const timerColor = isCrit ? C.red : (timerStarted ? C.amber : C.muted)
  const barColor   = isCrit ? C.red : C.amber
  const fbBg   = feedback==='correct' ? C.correctBg : feedback==='wrong' ? C.redBg : 'transparent'
  const fbColor= feedback==='correct' ? C.correct   : feedback==='wrong' ? C.red   : C.muted
  const fbText = feedback==='correct' ? '¡Correcto!'
               : feedback==='wrong'   ? 'Incorrecto'
               : feedback==='thinking'? 'El rival responde...'
               : loading              ? 'Cargando puzzle...'
               : `${currentTurn==='white'?'Blancas':'Negras'} juegan`

  const boardArea = (
    <div style={{ flex: desktop ? '0 0 auto' : undefined, width: desktop ? 'min(460px, 55vw)' : '100%' }}>
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
      <div style={{ borderRadius:8, overflow:'hidden', boxShadow:'0 8px 40px rgba(0,0,0,.5)' }}>
        {error
          ? <div style={{ aspectRatio:'1', background:C.surface, border:`1px solid ${C.red}30`, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:12, padding:24, textAlign:'center' }}>
              <div style={{ fontSize:14, fontWeight:600, color:C.red }}>Sin puzzles disponibles</div>
              <div style={{ fontSize:12, color:C.muted, maxWidth:300, lineHeight:1.5 }}>{error}</div>
              <button onClick={onRetry} style={{ padding:'8px 16px', borderRadius:8, background:C.amber, color:C.bg, border:'none', fontSize:13, fontWeight:600, cursor:'pointer', marginTop:4 }}>Reintentar</button>
            </div>
          : loading && !puzzle
            ? <div style={{ aspectRatio:'1', background:C.surface, display:'flex', alignItems:'center', justifyContent:'center', gap:10 }}><Spinner /><span style={{ ...mono, fontSize:12, color:C.muted }}>Cargando...</span></div>
            : puzzle && currentFen
              ? <ChessBoard key={puzzle.id} fen={currentFen} orientation={puzzle.turn} turn={currentTurn} dests={dests} onMove={onMove} feedback={feedback} />
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

  const sidePanel = (
    <div style={{ flex:1, display:'flex', flexDirection:'column', gap: desktop ? 20 : 12, minWidth:0 }}>

      {/* Timer — big on desktop */}
      <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding: desktop ? '24px 28px' : '12px 20px' }}>
        <div style={{ ...mono, fontSize: desktop ? 72 : 48, fontWeight:700, letterSpacing:-3, lineHeight:1, color:timerColor, transition:'color .4s', textAlign: desktop ? 'center' : undefined }}>{fmt(timeLeft)}</div>
        <div style={{ height:2, background:C.border, borderRadius:2, marginTop:10, overflow:'hidden' }}>
          <div style={{ height:'100%', width:`${pct}%`, background:barColor, borderRadius:2, transition:'width 1s linear' }} />
        </div>
        {desktop && <div style={{ ...mono, fontSize:9, letterSpacing:4, textTransform:'uppercase', color: timerStarted ? C.muted : C.amber, textAlign:'center', marginTop:8 }}>
          {timerStarted ? `STORM · ${minutes} MIN` : 'Jugá para comenzar'}
        </div>}
      </div>

      {/* Scores */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
        {[{v:scoreOk,c:C.correct,l:'Correctos'},{v:scoreErr,c:C.red,l:'Errores'}].map(s=>(
          <div key={s.l} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding: desktop ? '20px 16px' : '12px 16px', textAlign:'center' }}>
            <div style={{ ...mono, fontSize: desktop ? 40 : 28, fontWeight:700, color:s.c, lineHeight:1 }}>{s.v}</div>
            <div style={{ ...mono, fontSize:9, letterSpacing:2, color:C.muted, marginTop:6, textTransform:'uppercase' }}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* Puzzle number */}
      <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:'14px 20px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <span style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.muted }}>Puzzle</span>
        <span style={{ ...mono, fontSize: desktop ? 24 : 18, fontWeight:700, color:C.muted }}>#{puzzleNum}</span>
      </div>

      {/* End session — pushed to bottom on desktop */}
      {desktop && <div style={{ flex:1 }} />}
      <button onClick={onEnd} style={{ ...mono, fontSize:10, letterSpacing:2, textTransform:'uppercase', color:C.muted, cursor:'pointer', background:'none', border:'none', paddingTop:4, textAlign:'center' }}>
        Terminar sesión
      </button>
    </div>
  )

  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', flexDirection:'column', alignItems:'center', justifyContent: desktop ? 'center' : 'flex-start', padding: desktop ? '40px 48px' : '16px 16px 24px', fontFamily:"'DM Sans',system-ui,sans-serif" }}>
      <div style={{
        width:'100%',
        maxWidth: desktop ? 900 : 460,
        display: desktop ? 'flex' : 'flex',
        flexDirection: desktop ? 'row' : 'column',
        alignItems: desktop ? 'flex-start' : 'center',
        gap: desktop ? 32 : 12,
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


function ResultsScreen({ minutes, scoreOk, scoreErr, history, bestScores, onRepeat, onReview, onConfig }: {
  minutes:number; scoreOk:number; scoreErr:number
  history:HistoryEntry[]; bestScores:BestScores|null
  onRepeat:()=>void; onReview:()=>void; onConfig:()=>void
}) {
  const total=scoreOk+scoreErr, acc=total>0?Math.round((scoreOk/total)*100):0
  const wrong=history.filter(h=>h.result==='err')
  const desktop = useIsDesktop()

  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'40px 24px', fontFamily:"'DM Sans',system-ui,sans-serif", position:'relative' }}>
      <EasterShin />
      <div style={{ width:'100%', maxWidth: desktop ? 720 : 320 }}>

        {/* Score headline */}
        <div style={{ textAlign:'center', marginBottom:32 }}>
          <div style={{ ...mono, fontSize:9, letterSpacing:5, textTransform:'uppercase', color:C.muted, marginBottom:8 }}>Storm · {minutes} minuto{minutes>1?'s':''}</div>
          <div style={{ ...cinzel, fontSize: desktop ? 140 : 'clamp(80px,22vw,120px)', fontWeight:900, color:C.amber, lineHeight:1, letterSpacing:-3, marginBottom:4 }}>{scoreOk}</div>
          <div style={{ ...mono, fontSize:10, letterSpacing:4, textTransform:'uppercase', color:C.muted }}>puzzles resueltos</div>
        </div>

        {/* Stats */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom: bestScores ? 16 : 24 }}>
          {[{l:'Correctos',v:scoreOk,c:C.correct},{l:'Errores',v:scoreErr,c:C.red},{l:'Precisión',v:`${acc}%`,c:C.text}].map(s=>(
            <div key={s.l} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding: desktop ? '20px 12px' : '14px 8px', textAlign:'center' }}>
              <div style={{ ...mono, fontSize: desktop ? 36 : 30, fontWeight:700, color:s.c, lineHeight:1 }}>{s.v}</div>
              <div style={{ ...mono, fontSize:9, letterSpacing:2, textTransform:'uppercase', color:C.muted, marginTop:6 }}>{s.l}</div>
            </div>
          ))}
        </div>

        {/* Mejores puntajes — solo para usuarios autenticados */}
        {bestScores && (
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:'16px 20px', marginBottom:24 }}>
            <div style={{ ...mono, fontSize:9, letterSpacing:3, textTransform:'uppercase', color:C.muted, marginBottom:12 }}>Mejores puntajes</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, textAlign:'center' }}>
              {[
                { l:'Hoy',     v:bestScores.today },
                { l:'Semana',  v:bestScores.week },
                { l:'Mes',     v:bestScores.month },
                { l:'Total',   v:bestScores.allTime },
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

        {/* Errors section */}
        {wrong.length > 0 && (
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
        {wrong.length===0 && <div style={{ ...mono, fontSize:11, letterSpacing:2, textTransform:'uppercase', color:C.muted, textAlign:'center', marginBottom:24 }}>Sin errores · sesión perfecta</div>}

        <div style={{ display:'flex', gap:8 }}>
          <button onClick={onConfig} style={{ flex:1, padding:'13px 0', borderRadius:10, border:`1px solid ${C.border}`, background:C.surface, fontSize:13, fontWeight:500, color:C.muted, cursor:'pointer', fontFamily:"'DM Sans',sans-serif" }}>Configurar</button>
          <button onClick={onRepeat} style={{ flex:2, padding:'13px 0', borderRadius:10, background:C.amber, border:'none', color:C.bg, fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:"'DM Sans',sans-serif" }}>Repetir Storm</button>
        </div>
      </div>
    </div>
  )
}

// ══ Preparing ═════════════════════════════════════════════════════════════════
// Pantalla de carga mientras se preparan los primeros puzzles. El timer del
// Storm no arranca hasta que esto termina, para no "robar" tiempo al usuario.
function PreparingScreen({ minutes, error, onCancel, onRetry }: {
  minutes: number
  error: string | null
  onCancel: () => void
  onRetry: () => void
}) {
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
          Storm · {minutes} min
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
  const [authUser, setAuthUser] = useState<AuthUser|null>(null)
  const [isGuest,  setIsGuest]  = useState(false)
  const [minutes,  setMinutes]  = useState(3)
  const [selectedThemes,   setSelectedThemes]   = useState<string[]>([])
  const [selectedOpenings, setSelectedOpenings] = useState<string[]>([])
  const [minRating, setMinRating] = useState(1200)
  const [maxRating, setMaxRating] = useState(1800)
  const setRatingRange = useCallback((lo: number, hi: number) => {
    setMinRating(lo); setMaxRating(hi)
  }, [])

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

  const timerRef    = useRef<ReturnType<typeof setInterval>|null>(null)
  const nextRef     = useRef<ReturnType<typeof setTimeout>|null>(null)
  const queueRef    = useRef<PuzzleQueue|null>(null)
  const chessRef    = useRef<Chess|null>(null)
  const sessionStart = useRef<string>(new Date().toISOString())
  const seenIds      = useRef<string[]>([])

  // Cuando carga un puzzle nuevo, resetear posición
  useEffect(() => {
    if (!puzzle) return
    const c = new Chess(puzzle.fen)
    chessRef.current = c
    setCurrentFen(puzzle.fen)
    setCurrentTurn(puzzle.turn)
    setDests(computeDests(c))
    setMoveIdx(0)
  }, [puzzle?.id])

  // Init — escuchar cambios de auth de Supabase
  useEffect(() => {
    const unsub = onAuthStateChange(async (supaUser) => {
      if (supaUser) {
        const built = buildAuthUser(supaUser)
        const profile = await getProfile(supaUser.id).catch(() => null)
        if (profile?.lichess_elo) {
          built.lichessElo = profile.lichess_elo
          built.lichessId  = profile.lichess_id
          if (profile.username) built.username = profile.username
          // Calibrar slider al ELO guardado
          setMinRating(Math.max(400, profile.lichess_elo - 200))
          setMaxRating(Math.min(3000, profile.lichess_elo + 200))
        }

        // Traer mejores scores si ya tiene sesiones
        getBestScores(supaUser.id).then(setBestScores).catch(() => {})

        setAuthUser(built)
        setIsGuest(false)
        setAppState('config')
      } else if (appState === 'init') {
        // Sin sesión activa → ir a login
        setAppState('login')
      }
    })
    return unsub
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Storm timer
  useEffect(() => {
    if (appState !== 'storm' || screen !== 'storm' || !timerStarted) return
    timerRef.current = setInterval(() => {
      setTimeLeft(t => { if(t<=1){clearInterval(timerRef.current!);setScreen('results');return 0} return t-1 })
    }, 1000)
    return () => clearInterval(timerRef.current!)
  }, [appState, screen, timerStarted])

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
    if (feedback !== 'idle' || !puzzle || !chessRef.current || loading) return
    if (!timerStarted) setTimerStarted(true)

    const expected  = puzzle.solution[moveIdx]
    const userMove  = orig + dest
    const isCorrect = validateMove(currentFen, userMove, expected)

    if (!isCorrect) {
      setFeedback('wrong'); setScoreErr(s=>s+1)
      setHistory(h=>[...h, {...puzzle, result:'err'}])
      nextRef.current = setTimeout(advanceToNext, 400)
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
      nextRef.current = setTimeout(advanceToNext, 400)
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
    }, 300)
  }, [feedback, puzzle, loading, moveIdx, currentFen, advanceToNext, timerStarted])

  const startStorm = useCallback(async () => {
    clearInterval(timerRef.current!); clearTimeout(nextRef.current!)
    setTimeLeft(minutes*60); setPuzzleCount(0); setTimerStarted(false)
    setScoreOk(0); setScoreErr(0); setFeedback('idle'); setHistory([])
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
      const sessionId = await saveSession({
        user_id:      authUser.id,
        mode:         'storm',
        minutes,
        themes:       Object.values(groups).flat().filter(t => !t.includes('_')),
        opening_tags: groups.openingTags ?? [],
        min_rating:   minRating,
        max_rating:   maxRating,
        score_ok:     scoreOk,
        score_err:    scoreErr,
        puzzles_seen: seenIds.current,
        started_at:   sessionStart.current,
      })

      // Guardar errores
      if (sessionId) {
        const errIds = history.filter(h => h.result === 'err').map(h => h.id)
        await saveSessionErrors(sessionId, errIds)
      }

      // Refrescar mejores scores
      getBestScores(authUser.id).then(setBestScores).catch(() => {})
    }
  }, [authUser, isGuest, minutes, selectedThemes, selectedOpenings, minRating, maxRating, scoreOk, scoreErr, history])

  const goConfig = useCallback(() => {
    clearInterval(timerRef.current!); clearTimeout(nextRef.current!)
    setAppState('config'); setScreen('storm')
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
          lichess_id:  account.id,
          lichess_elo: account.puzzleElo,
          username:    account.username,
        })

        // Actualizar estado local
        setAuthUser(prev => prev ? {
          ...prev,
          lichessId:  account.id,
          lichessElo: account.puzzleElo,
          username:   account.username,
        } : prev)

        // Calibrar slider al ELO de Lichess
        if (account.puzzleElo) {
          setMinRating(Math.max(400, account.puzzleElo - 200))
          setMaxRating(Math.min(3000, account.puzzleElo + 200))
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
  if (appState==='config') return (
    <ConfigScreen
      user={authUser??undefined} isGuest={isGuest}
      minutes={minutes} setMinutes={setMinutes}
      selectedThemes={selectedThemes} setSelectedThemes={setSelectedThemes}
      selectedOpenings={selectedOpenings} setSelectedOpenings={setSelectedOpenings}
      minRating={minRating} maxRating={maxRating} setRatingRange={setRatingRange}
      onStart={startStorm} onLogout={logout} onConnectLichess={connectLichess}
    />
  )
  if (appState==='preparing') return <PreparingScreen minutes={minutes} error={fetchError} onCancel={goConfig} onRetry={startStorm} />
  if (appState==='storm' && screen==='storm') return (
    <StormScreen
      puzzle={puzzle} currentFen={currentFen} currentTurn={currentTurn}
      dests={dests} puzzleNum={puzzleCount+1}
      minutes={minutes} timeLeft={timeLeft} timerStarted={timerStarted}
      scoreOk={scoreOk} scoreErr={scoreErr} feedback={feedback}
      loading={loading} error={fetchError} onRetry={loadNext}
      onMove={handleMove} onEnd={endSess}
    />
  )
  if (appState==='review') return <ReviewScreen puzzles={reviewPuzzles} idx={reviewIdx} onNext={nextReview} onBack={backToResults} />
  return (
    <ResultsScreen
      minutes={minutes} scoreOk={scoreOk} scoreErr={scoreErr}
      history={history} bestScores={bestScores}
      onRepeat={startStorm} onReview={startReview} onConfig={goConfig}
    />
  )
}

// Audio feedback minimalista usando Web Audio API. Sin librerías ni archivos
// de audio externos — los sonidos se sintetizan al vuelo con osciladores y
// envolventes ADSR simples para mantener el bundle liviano.
//
// El AudioContext se crea LAZY al primer sonido — los browsers requieren
// gesture del usuario para iniciarlo. Si fallaron las políticas, los métodos
// son no-op.

const STORAGE_KEY = 'shajmat_sound'

let ctx: AudioContext | null = null
function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (ctx) return ctx
  const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
  if (!Ctor) return null
  try { ctx = new Ctor() } catch { ctx = null }
  return ctx
}

// Volumen general — bajo para no ser intrusivo
const MASTER_GAIN = 0.15

// ─── Toggle de sonido (persistido en localStorage) ─────────────────────────
export function isSoundEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(STORAGE_KEY) === '1'
}

export function toggleSound(): boolean {
  if (typeof window === 'undefined') return false
  const next = !isSoundEnabled()
  window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
  return next
}

// ─── Helper: emite un tono con envolvente ADSR sencilla ────────────────────
//
// freq:        frecuencia en Hz (puede ser número o función para barrido)
// duration:    duración total en ms (incluye attack + decay/release)
// type:        forma de onda
// curve:       'flat' | 'rise' | 'fall' — modulación de pitch durante el tono
function tone(freq: number, duration: number, type: OscillatorType = 'sine', curve: 'flat'|'rise'|'fall' = 'flat'): void {
  if (!isSoundEnabled()) return
  const c = getCtx()
  if (!c) return
  // En algunos browsers el ctx queda 'suspended' hasta el primer gesture
  if (c.state === 'suspended') c.resume().catch(() => {})

  const now = c.currentTime
  const dur = duration / 1000

  const osc = c.createOscillator()
  osc.type = type
  osc.frequency.setValueAtTime(freq, now)
  if (curve === 'rise')      osc.frequency.linearRampToValueAtTime(freq * 1.5, now + dur)
  else if (curve === 'fall') osc.frequency.linearRampToValueAtTime(freq * 0.6, now + dur)

  const gain = c.createGain()
  // Envolvente: attack 8ms, decay/release el resto
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(MASTER_GAIN, now + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur)

  osc.connect(gain).connect(c.destination)
  osc.start(now)
  osc.stop(now + dur + 0.01)
}

// ─── Movimiento correcto: tono ascendente agradable ────────────────────────
export function playCorrect(): void {
  tone(523.25, 150, 'sine', 'rise')   // Do5 sube ~Sol5
}

// ─── Movimiento incorrecto: tono descendente sutil ─────────────────────────
export function playWrong(): void {
  tone(200, 200, 'triangle', 'fall')
}

// ─── Pieza rival responde: click suave neutro ──────────────────────────────
export function playMove(): void {
  tone(300, 80, 'sine', 'flat')
}

// ─── Aviso 30s: dos pulsos cortos de alerta ────────────────────────────────
export function playWarning(): void {
  tone(440, 100, 'square', 'flat')
  setTimeout(() => tone(440, 100, 'square', 'flat'), 150)
}

// Audio feedback usando los archivos MP3 de Lichess (licencia MIT).
// Antes generábamos los tonos con Web Audio API pero el resultado sonaba
// sintético — los SFX de Lichess están polished y los usuarios de ajedrez
// ya los reconocen.
//
// Los archivos viven en /public/sounds/ (Move.mp3, Capture.mp3,
// GenericNotify.mp3, Error.mp3). Vienen del repo lichess-org/lila.
//
// Pre-cargamos los Audio elements al cargar el módulo para evitar lag en
// la primera reproducción. Cada `play()` reinicia con currentTime = 0
// para que los pulsos rápidos (warning) no se solapen consigo mismos.

const STORAGE_KEY = 'shajmat_sound'

// Volumen general — bajo para no ser intrusivo. Los assets de Lichess
// están bien normalizados así que con 0.5 alcanza.
const MASTER_VOLUME = 0.5

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

// ─── Pre-carga de audio elements ───────────────────────────────────────────
// Los creamos perezosamente para no fallar en SSR/tests sin window.
// preload='auto' fuerza al browser a bajar el archivo al instanciar el
// elemento, así la primera reproducción no tiene jitter.
type SoundKey = 'move' | 'correct' | 'wrong' | 'notify'

const SOUND_FILES: Record<SoundKey, string> = {
  move:    '/sounds/Move.mp3',
  correct: '/sounds/GenericNotify.mp3',
  // OutOfBound — un "thud" más marcado que Error.mp3 (era un blip bajo
  // que se confundía con el buzz sintético anterior).
  wrong:   '/sounds/OutOfBound.mp3',
  notify:  '/sounds/GenericNotify.mp3',
}

let cache: Partial<Record<SoundKey, HTMLAudioElement>> = {}

function getAudio(key: SoundKey): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null
  const cached = cache[key]
  if (cached) return cached
  try {
    const a = new Audio(SOUND_FILES[key])
    a.preload = 'auto'
    a.volume  = MASTER_VOLUME
    cache[key] = a
    return a
  } catch {
    return null
  }
}

// Pre-cargar todos los assets al importar el módulo (no-op en SSR)
if (typeof window !== 'undefined') {
  for (const key of Object.keys(SOUND_FILES) as SoundKey[]) getAudio(key)
}

// Reproduce un sonido respetando el toggle. Reinicia el elemento al inicio
// para soportar disparos rápidos consecutivos (caso típico: warning doble).
function play(key: SoundKey): void {
  if (!isSoundEnabled()) return
  const a = getAudio(key)
  if (!a) return
  try {
    a.currentTime = 0
    // .play() devuelve una Promise que rechaza si el browser bloquea por
    // falta de gesture. La descartamos silenciosamente — el usuario va a
    // hacer click en algún momento y la próxima vez funciona.
    a.play().catch(() => {})
  } catch {}
}

// ─── API pública — mismo shape que la versión Web Audio ───────────────────

// Movimiento correcto del jugador
export function playCorrect(): void { play('correct') }

// Movimiento incorrecto del jugador
export function playWrong(): void { play('wrong') }

// Pieza del rival responde
export function playMove(): void { play('move') }

// Aviso de 30 segundos: dos pulsos cortos del notify con 200ms entre medio
export function playWarning(): void {
  play('notify')
  setTimeout(() => play('notify'), 200)
}

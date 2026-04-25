// Wrapper de Stockfish 18 (lite, single-threaded WASM) — corre como Worker.
//
// Solo se monta una vez por uso (vía useStockfish hook). El wrapper:
//   1. Crea el Worker apuntando a /stockfish/stockfish-18-lite-single.js
//      (los .wasm y .js viven en public/stockfish/, copiados del paquete npm
//      `stockfish` durante el setup del feature).
//   2. Habla UCI: posiciona FEN, lanza `go depth N`, parsea las líneas
//      `info depth ... score ... pv ...` y `bestmove ...`.
//   3. Expone `analyze(fen, depth, onUpdate, onDone)` con cancelación.
//
// Diseño: una sola búsqueda activa por instancia. `analyze()` envía `stop`
// si hay una búsqueda en curso antes de empezar la siguiente — el engine
// emite el bestmove final del anterior y descarta el resto.
//
// El motor reporta evaluaciones desde la perspectiva del lado a mover.
// Para mostrar consistente "+ favorece blancas / – favorece negras" lo
// normalizamos en `normalizeScore`.

export type EngineScore =
  | { type: 'cp';   value: number }   // centipawns desde POV del que mueve
  | { type: 'mate'; value: number }   // mate en N (positivo = quien mueve)

export interface AnalysisUpdate {
  depth:    number
  score:    EngineScore        // POV del lado a mover en `fen`
  pv:       string[]           // jugadas en UCI (e.g. ['e2e4', 'e7e5'])
  bestMove: string             // primer movimiento del PV
  turn:     'white' | 'black'  // quién mueve en `fen`
}

// Detección de soporte. WebAssembly + Worker son requisitos.
export function isStockfishSupported(): boolean {
  if (typeof window === 'undefined') return false
  return typeof WebAssembly === 'object' && typeof Worker === 'function'
}

// ── Engine class ──────────────────────────────────────────────────────────
//
// Una instancia maneja un solo Worker reusable. El método `analyze`
// cancela la búsqueda anterior si hay una en curso.

export class StockfishEngine {
  private worker: Worker
  private ready:  Promise<void>
  // null cuando no hay búsqueda activa
  private active: {
    turn:     'white' | 'black'
    onUpdate: (u: AnalysisUpdate) => void
    onDone:   (u: AnalysisUpdate | null) => void
    last:     AnalysisUpdate | null
  } | null = null
  // Cuando lanzamos un nuevo análisis sobre uno en curso mandamos `stop`,
  // y el motor responde con un `bestmove` y posibles `info` residuales del
  // search anterior. Mientras este flag esté en true ignoramos todo hasta
  // recibir ese bestmove de despedida.
  private ignoringResidual = false

  constructor() {
    this.worker = new Worker('/stockfish/stockfish-18-lite-single.js')
    // Esperar a "uciok" antes de aceptar comandos. El motor emite eso
    // tras procesar `uci`.
    this.ready = new Promise<void>(resolve => {
      const onMsg = (e: MessageEvent) => {
        if (typeof e.data === 'string' && e.data.includes('uciok')) {
          this.worker.removeEventListener('message', onMsg)
          this.worker.postMessage('isready')
          resolve()
        }
      }
      this.worker.addEventListener('message', onMsg)
      this.worker.postMessage('uci')
    })
    this.worker.addEventListener('message', e => this.onMessage(e.data))
  }

  // Lanza un análisis nuevo de `fen` a `depth` plies.
  // Si hay una búsqueda anterior, manda `stop` y arranca la nueva. El
  // motor encola los `go` internamente y procesa el siguiente cuando termina
  // el actual; las líneas residuales del search anterior se ignoran.
  // `onUpdate` recibe cada `info depth N` parseable con un PV.
  // `onDone` se llama una sola vez cuando el motor emite `bestmove`.
  async analyze(
    fen:      string,
    depth:    number,
    onUpdate: (u: AnalysisUpdate) => void,
    onDone:   (u: AnalysisUpdate | null) => void,
  ): Promise<void> {
    await this.ready

    if (this.active) {
      // Marcar que vamos a ver un bestmove residual y enviar stop
      this.ignoringResidual = true
      this.worker.postMessage('stop')
    }

    const turn = fen.split(' ')[1] === 'b' ? 'black' : 'white'
    this.active = { turn, onUpdate, onDone, last: null }

    this.worker.postMessage('ucinewgame')
    this.worker.postMessage(`position fen ${fen}`)
    this.worker.postMessage(`go depth ${depth}`)
  }

  // Cancela la búsqueda actual notificando al consumidor con onDone(null).
  // Usado al desactivar el toggle o al desmontar.
  stop(): void {
    if (this.active) {
      const a = this.active
      this.active = null
      this.ignoringResidual = true  // descartar el bestmove de despedida
      this.worker.postMessage('stop')
      a.onDone(null)
    }
  }

  // Termina el worker (al desmontar el hook).
  destroy(): void {
    try { this.worker.postMessage('quit') } catch {}
    try { this.worker.terminate() }       catch {}
  }

  // ── Parser UCI ─────────────────────────────────────────────────────────

  private onMessage(line: unknown): void {
    if (typeof line !== 'string') return

    if (this.ignoringResidual) {
      // Descartamos infos residuales hasta que llegue el bestmove de despedida
      if (line.startsWith('bestmove ')) this.ignoringResidual = false
      return
    }

    if (!this.active) return
    const a = this.active

    if (line.startsWith('info ')) {
      const u = parseInfo(line, a.turn)
      if (u) {
        a.last = u
        a.onUpdate(u)
      }
      return
    }

    if (line.startsWith('bestmove ')) {
      // Búsqueda terminada: guardamos último update y notificamos
      this.active = null
      a.onDone(a.last)
    }
  }
}

// ── Parser para una línea `info ...` ─────────────────────────────────────
//
// Ejemplo de línea:
//   info depth 18 seldepth 24 multipv 1 score cp 35 nodes 123456 nps 78900
//        time 1500 pv e2e4 e7e5 g1f3 b8c6 ...
//
// Solo nos interesan: depth, score (cp|mate) y pv. Ignoramos líneas sin pv
// (por ej. las del currmove, que no tienen pv y son ruido).
function parseInfo(line: string, turn: 'white' | 'black'): AnalysisUpdate | null {
  const tokens = line.split(/\s+/)
  let depth = 0
  let score: EngineScore | null = null
  let pv: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === 'depth')  depth = parseInt(tokens[++i], 10) || 0
    else if (t === 'score') {
      const kind = tokens[++i]
      const val  = parseInt(tokens[++i], 10)
      if (kind === 'cp')   score = { type: 'cp',   value: val }
      if (kind === 'mate') score = { type: 'mate', value: val }
    }
    else if (t === 'pv') {
      pv = tokens.slice(i + 1).filter(s => /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(s))
      break
    }
  }

  if (!score || pv.length === 0) return null
  return { depth, score, pv, bestMove: pv[0], turn }
}

// ── Helpers de presentación ──────────────────────────────────────────────

// Convierte el score POV-del-que-mueve a POV-blancas (positivo = blancas mejor).
// Útil para la barra de eval que es siempre desde la perspectiva del blanco.
export function scoreFromWhite(u: AnalysisUpdate): EngineScore {
  if (u.turn === 'white') return u.score
  return u.score.type === 'cp'
    ? { type: 'cp',   value: -u.score.value }
    : { type: 'mate', value: -u.score.value }
}

// Texto corto tipo Lichess: "+1.4", "−0.8", "M3", "−M2", "0.0"
export function formatScore(s: EngineScore): string {
  if (s.type === 'mate') {
    if (s.value === 0)  return '0-1' // mate ya entregado (no debería pasar en análisis)
    const sign = s.value > 0 ? '' : '−'
    return `${sign}M${Math.abs(s.value)}`
  }
  if (s.value === 0) return '0.0'
  const pawns = s.value / 100
  const sign = pawns > 0 ? '+' : '−'
  return `${sign}${Math.abs(pawns).toFixed(1)}`
}

// "Blancas mejor" / "Negras mejor" / "Igualada".
// Threshold de 30cp (~1/3 de peón) para considerar igualada — alineado con
// el criterio común en análisis rápido.
export function scoreFavors(s: EngineScore): 'white' | 'black' | 'equal' {
  if (s.type === 'mate') return s.value > 0 ? 'white' : 'black'
  if (Math.abs(s.value) < 30) return 'equal'
  return s.value > 0 ? 'white' : 'black'
}

// Convierte un score POV-blancas a porcentaje 0..1 para la barra de eval.
// Curva sigmoide tipo Lichess: cap a ~7 peones, mate = 0 ó 1.
export function scoreToBarPct(s: EngineScore): number {
  if (s.type === 'mate') return s.value > 0 ? 1 : 0
  // Curva sigmoide: 1 / (1 + e^(-cp/350)). 350cp ≈ medio peón = 50% de cap.
  // Da una barra que se mueve notablemente entre +0..+200 y satura cerca de +700.
  const x = s.value / 350
  return 1 / (1 + Math.exp(-x))
}

// Convierte un PV (jugadas UCI) a notación SAN, partiendo del FEN dado.
// Devuelve array de jugadas SAN; si una jugada falla, corta el PV ahí.
// Importa chess.js dinámicamente si no se usó antes en el módulo.
import { Chess } from 'chess.js'

export function pvToSan(fen: string, pv: string[], maxMoves = 5): string[] {
  try {
    const c = new Chess(fen)
    const out: string[] = []
    for (const uci of pv.slice(0, maxMoves)) {
      const m = c.move({
        from: uci.slice(0, 2),
        to:   uci.slice(2, 4),
        promotion: uci.length > 4 ? (uci[4] as 'q'|'r'|'b'|'n') : undefined,
      })
      if (!m) break
      out.push(m.san)
    }
    return out
  } catch {
    return []
  }
}

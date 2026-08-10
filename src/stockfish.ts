// ══ Stockfish (motor de análisis) ═════════════════════════════════════════════
//
// Wrapper sobre stockfish.js@10.0.2 (build puro JS, sin WASM ni
// SharedArrayBuffer — corre en cualquier browser sin headers COOP/COEP y va
// bien con la PWA offline). El archivo del motor vive en
// public/stockfish/stockfish.js y se carga como Web Worker clásico.
//
// El motor sigue el protocolo UCI. Nosotros mandamos strings (`uci`,
// `position fen ...`, `go depth ...`, `stop`) y parseamos las respuestas.
// Emitimos cada frame nuevo al listener registrado con onEval().
//
// Diseño:
//   - Una instancia = un worker. Uso pesado: crear una sola por review y
//     destruirla al salir.
//   - Cada analyze(fen) cancela el análisis anterior y arranca uno nuevo.
//     Los info lines devueltos incluyen el FEN al que corresponden, así el
//     consumer puede descartar respuestas obsoletas si hiciera falta.
//   - La evaluación (cp/mate) viene desde la perspectiva del bando que
//     juega en el FEN. Convertí a perspectiva de blanco en la UI si
//     necesitás signo estable.

// Licencia: Stockfish es GPL-3. El binario incluído en public/stockfish/
// mantiene el copyright original + licencia (Copying.txt). Ver About en la
// app y notas de licencia en el README.

export interface EvalInfo {
  fen:       string       // Posición analizada
  depth:     number       // Profundidad alcanzada
  cp?:       number       // Score en centipawns (perspectiva del bando a mover)
  mate?:     number       // Mate en N (perspectiva del bando a mover; negativo si te dan mate)
  pv:        string[]     // Línea principal (movidas UCI)
  bestMove?: string       // Cuando el análisis terminó (bestmove <uci>)
  done:      boolean      // true en el evento final de este análisis
}

interface AnalyzeOptions {
  depth?: number   // Profundidad máxima (default 18)
}

// Parsea una línea `info depth ... score ... pv ...`.
// Devuelve null si la línea no trae score utilizable (algunos info sólo
// traen currmove/nps sin score — los ignoramos).
function parseInfoLine(line: string, fen: string): EvalInfo | null {
  const tokens = line.split(/\s+/)
  let depth: number | undefined
  let cp:    number | undefined
  let mate:  number | undefined
  let pv:    string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === 'depth') {
      depth = parseInt(tokens[++i], 10)
    } else if (t === 'score') {
      const kind = tokens[i + 1]
      const val  = parseInt(tokens[i + 2], 10)
      if (kind === 'cp')        { cp   = val; i += 2 }
      else if (kind === 'mate') { mate = val; i += 2 }
    } else if (t === 'pv') {
      pv = tokens.slice(i + 1).filter(Boolean)
      break
    }
  }
  if (depth === undefined) return null
  if (cp === undefined && mate === undefined) return null
  return { fen, depth, cp, mate, pv, done: false }
}

export class StockfishEngine {
  private worker: Worker | null = null
  private currentFen: string | null = null
  private listener: ((info: EvalInfo) => void) | null = null
  private readyResolve: (() => void) | null = null
  private readyPromise: Promise<void>
  private disposed = false

  constructor() {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      try {
        this.worker = new Worker('/stockfish/stockfish.js')
        this.worker.onmessage = (e) => this.handleMessage(String(e.data))
        this.worker.onerror = (e) => {
          console.error('Stockfish worker error:', e)
          reject(new Error('No se pudo iniciar el motor de análisis'))
        }
        this.worker.postMessage('uci')
      } catch (err) {
        reject(err)
      }
    })
  }

  // Espera a que el motor esté listo (recibió 'uciok').
  ready$(): Promise<void> { return this.readyPromise }

  onEval(cb: (info: EvalInfo) => void) { this.listener = cb }

  // Cancela el análisis en curso y arranca uno nuevo para `fen`.
  async analyze(fen: string, opts: AnalyzeOptions = {}) {
    if (this.disposed) return
    await this.readyPromise
    if (this.disposed || !this.worker) return
    const depth = opts.depth ?? 18
    this.currentFen = fen
    // `stop` aborta el análisis anterior (si estaba corriendo). `ucinewgame`
    // resetea el hash — sin esto Stockfish acumula tablas de posiciones
    // pasadas y puede dar evals inconsistentes al saltar entre puzzles.
    this.worker.postMessage('stop')
    this.worker.postMessage('ucinewgame')
    this.worker.postMessage(`position fen ${fen}`)
    this.worker.postMessage(`go depth ${depth}`)
  }

  stop() {
    if (this.disposed || !this.worker) return
    this.worker.postMessage('stop')
  }

  destroy() {
    if (this.disposed) return
    this.disposed = true
    this.listener = null
    if (this.worker) {
      try { this.worker.postMessage('quit') } catch { /* ignore */ }
      this.worker.terminate()
      this.worker = null
    }
  }

  private handleMessage(line: string) {
    if (this.disposed) return
    if (line === 'uciok') {
      this.worker?.postMessage('setoption name UCI_AnalyseMode value true')
      // MultiPV=1 (una sola línea). Si en el futuro queremos top-N,
      // subir este número + parsear multipv en info lines.
      this.worker?.postMessage('setoption name MultiPV value 1')
      this.readyResolve?.()
      this.readyResolve = null
      return
    }
    if (line.startsWith('info ')) {
      if (!this.currentFen || !this.listener) return
      const info = parseInfoLine(line, this.currentFen)
      if (info) this.listener(info)
      return
    }
    if (line.startsWith('bestmove ')) {
      const bm = line.split(/\s+/)[1]
      if (this.currentFen && this.listener && bm && bm !== '(none)') {
        this.listener({
          fen: this.currentFen, depth: 0, pv: [bm],
          bestMove: bm, done: true,
        })
      }
      return
    }
  }
}

// Formatea una evaluación para mostrar en UI:
//   +1.5    ventaja de 1.5 peones (para blanco)
//   -0.3    ventaja para negro
//   M4      mate en 4 movidas
//   -M2     te dan mate en 2
//
// `whitePerspective`: si true, invierte el signo cuando el fen es de negras
// (para que positivo siempre sea "ventaja blanca").
export function formatEval(info: EvalInfo | null, whitePerspective = true): string {
  if (!info) return '—'
  const blackToMove = whitePerspective && info.fen.split(' ')[1] === 'b'
  if (info.mate !== undefined) {
    const m = blackToMove ? -info.mate : info.mate
    return (m > 0 ? 'M' : '-M') + Math.abs(m)
  }
  if (info.cp !== undefined) {
    const cp = blackToMove ? -info.cp : info.cp
    const val = cp / 100
    return (val > 0 ? '+' : '') + val.toFixed(1)
  }
  return '—'
}

// Devuelve un número en [0, 1] para dibujar la barra vertical:
//   0.5 = igualdad
//   1.0 = blanco gana ampliamente
//   0.0 = negro gana ampliamente
// Usa la típica curva sigmoide-ish sobre centipawns; los mates saturan.
export function evalToBarFraction(info: EvalInfo | null): number {
  if (!info) return 0.5
  const blackToMove = info.fen.split(' ')[1] === 'b'
  if (info.mate !== undefined) {
    const m = blackToMove ? -info.mate : info.mate
    return m > 0 ? 1 : 0
  }
  if (info.cp !== undefined) {
    const cp = blackToMove ? -info.cp : info.cp
    // Mapeo suave: ~±10 peones satura visualmente.
    const clamped = Math.max(-1000, Math.min(1000, cp))
    return 0.5 + (clamped / 2000)
  }
  return 0.5
}

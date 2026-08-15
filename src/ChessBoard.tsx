import { useEffect, useRef } from 'react'
import { Chessground } from 'chessground'
import type { Api } from 'chessground/api'
import type { Key } from 'chessground/types'
import type { DrawShape } from 'chessground/draw'

interface ChessBoardProps {
  fen:         string
  orientation?: 'white' | 'black'
  turn?:        'white' | 'black'
  onMove:       (orig: string, dest: string) => void
  feedback:     'idle' | 'thinking' | 'correct' | 'wrong'
  dests?:       Map<Key, Key[]>
  showDests?:   boolean
  // Practice: retraso antes de hacer snap-back en una jugada incorrecta (estilo Lichess)
  wrongRevertDelay?: number
  // Hints: 0 = nada, 1 = círculo en origen, 2 = flecha origen→destino
  hintLevel?: 0 | 1 | 2
  hintMove?:  string  // UCI move tipo 'e2e4'
  // Extra shapes (por ej. flecha de la mejor jugada del motor). Se dibujan
  // junto con las de hint. Cambiar la referencia dispara re-render.
  extraShapes?: DrawShape[]
  // Bloquea input sin cambiar `movable.color` — útil mientras un selector
  // de promoción está abierto y no queremos que el usuario mueva más piezas.
  inputLocked?: boolean
  // Cambiar este número fuerza al ChessBoard a re-sincronizar la posición
  // visual con `fen`. Necesario cuando el user "canceló" una jugada
  // (chessground ya movió la pieza visualmente pero el FEN sigue siendo
  // el de antes) y queremos snap-back sin re-montar el componente.
  resetSignal?: number
  // UCI de la última movida (para que chessground pinte las casillas
  // orig+dest con su highlight built-in — sutil, no invasivo).
  lastMove?: string
}

export function ChessBoard({
  fen, orientation = 'white', turn = 'white', onMove, feedback,
  dests, showDests = false, wrongRevertDelay = 0, hintLevel = 0, hintMove,
  extraShapes, inputLocked = false, resetSignal = 0, lastMove,
}: ChessBoardProps) {
  const lastMoveKeys: [Key, Key] | undefined = lastMove && lastMove.length >= 4
    ? [lastMove.slice(0, 2) as Key, lastMove.slice(2, 4) as Key]
    : undefined
  const containerRef = useRef<HTMLDivElement>(null)
  const cgRef        = useRef<Api | null>(null)
  const onMoveRef    = useRef(onMove)
  onMoveRef.current  = onMove

  // Construir las shapes de hint (círculo en origen y/o flecha origen→destino)
  // combinadas con las extraShapes que venga desde afuera (motor, etc.).
  const autoShapes: DrawShape[] = (() => {
    const shapes: DrawShape[] = []
    if (hintMove && hintLevel > 0) {
      const orig = hintMove.slice(0, 2) as Key
      const dest = hintMove.slice(2, 4) as Key
      if (hintLevel === 1)      shapes.push({ orig, brush: 'green' })
      else if (hintLevel >= 2)  shapes.push({ orig, dest, brush: 'green' })
    }
    if (extraShapes && extraShapes.length > 0) shapes.push(...extraShapes)
    return shapes
  })()

  // Create Chessground ONCE on mount, destroy on unmount
  useEffect(() => {
    if (!containerRef.current) return
    cgRef.current = Chessground(containerRef.current, {
      fen,
      orientation,
      turnColor: turn,
      coordinates: true,
      lastMove: lastMoveKeys,
      movable: {
        color: turn,
        free:  false,        // only allow legal moves; invalid clicks deselect
        dests: dests ?? new Map(),
        showDests,
        events: { after: (o, d) => onMoveRef.current(o, d) },
      },
      animation:  { enabled: true, duration: 150 },
      highlight:  { lastMove: true, check: true },
      premovable: { enabled: false },
      draggable:  { enabled: true, distance: 3, showGhost: true },
      selectable: { enabled: true },
      drawable:   { enabled: true, autoShapes },
    })
    return () => { cgRef.current?.destroy(); cgRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update whenever props change — single source of truth
  useEffect(() => {
    if (!cgRef.current) return

    const applyAll = () => {
      cgRef.current?.set({
        fen,
        orientation,
        turnColor: turn,
        lastMove: lastMoveKeys,
        movable: {
          color: (feedback === 'idle' && !inputLocked) ? turn : undefined,
          dests: dests ?? new Map(),
          showDests,
        },
        drawable: { autoShapes },
      })
    }

    // Lichess-style: en una jugada incorrecta dejamos la pieza en el cuadro equivocado
    // por wrongRevertDelay ms antes de revertir, para que el usuario vea su error.
    // Mientras tanto, bloqueamos input vía movable.color = undefined (sin tocar fen).
    if (feedback === 'wrong' && wrongRevertDelay > 0) {
      cgRef.current.set({ movable: { color: undefined }, drawable: { autoShapes } })
      const t = setTimeout(applyAll, wrongRevertDelay)
      return () => clearTimeout(t)
    }
    applyAll()
    // resetSignal es una dep intencional aunque no la usemos en el body: cambiarla
    // fuerza al effect a re-correr y re-aplicar el fen (snap-back tras cancelar
    // una promoción, por ejemplo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, orientation, turn, feedback, dests, showDests, wrongRevertDelay, hintLevel, hintMove, extraShapes, inputLocked, resetSignal, lastMove])

  const ring =
    feedback === 'correct' ? 'ring-2 ring-[#6dbf6d] ring-offset-2 ring-offset-[#0e0d0b]' :
    feedback === 'wrong'   ? 'ring-2 ring-[#e05252] ring-offset-2 ring-offset-[#0e0d0b]' : ''

  return (
    <div className={`relative rounded-sm overflow-hidden transition-all duration-300 ${ring}`}
      style={{ width: '100%', aspectRatio: '1' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}

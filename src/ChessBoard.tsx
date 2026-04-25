import { useEffect, useRef } from 'react'
import { Chessground } from 'chessground'
import type { Api } from 'chessground/api'
import type { Key } from 'chessground/types'
import type { DrawShape, DrawBrushes } from 'chessground/draw'

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
  // Flecha del análisis del engine — UCI move (ámbar, no se confunde con hint verde)
  engineMove?: string
}

export function ChessBoard({
  fen, orientation = 'white', turn = 'white', onMove, feedback,
  dests, showDests = false, wrongRevertDelay = 0, hintLevel = 0, hintMove, engineMove,
}: ChessBoardProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cgRef        = useRef<Api | null>(null)
  const onMoveRef    = useRef(onMove)
  onMoveRef.current  = onMove

  // Shapes auto: hint del puzzle (verde) + best move del engine (ámbar).
  // El engine usa un brush 'amber' definido en drawable.brushes más abajo.
  const autoShapes: DrawShape[] = (() => {
    const out: DrawShape[] = []
    if (hintMove && hintLevel >= 1) {
      const orig = hintMove.slice(0, 2) as Key
      const dest = hintMove.slice(2, 4) as Key
      if (hintLevel === 1) out.push({ orig, brush: 'green' })
      else                 out.push({ orig, dest, brush: 'green' })
    }
    if (engineMove && engineMove.length >= 4) {
      const orig = engineMove.slice(0, 2) as Key
      const dest = engineMove.slice(2, 4) as Key
      out.push({ orig, dest, brush: 'amber' })
    }
    return out
  })()

  // Create Chessground ONCE on mount, destroy on unmount
  useEffect(() => {
    if (!containerRef.current) return
    cgRef.current = Chessground(containerRef.current, {
      fen,
      orientation,
      turnColor: turn,
      coordinates: true,
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
      drawable:   {
        enabled: true,
        autoShapes,
        // Brush ámbar para la flecha del engine, alineado con los acentos de la app.
        // Chessground tipa `brushes` como Required (todos los colores), pero en runtime
        // hace merge con los defaults — castamos para inyectar solo el nuevo brush.
        brushes: { amber: { key: 'a', color: '#c17f2a', opacity: 0.9, lineWidth: 10 } } as unknown as DrawBrushes,
      },
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
        movable: {
          color: feedback === 'idle' ? turn : undefined,
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
  }, [fen, orientation, turn, feedback, dests, showDests, wrongRevertDelay, hintLevel, hintMove, engineMove])

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

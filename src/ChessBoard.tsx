import { useEffect, useRef } from 'react'
import { Chessground } from 'chessground'
import type { Api } from 'chessground/api'
import type { Key } from 'chessground/types'

interface ChessBoardProps {
  fen:         string
  orientation?: 'white' | 'black'
  turn?:        'white' | 'black'
  onMove:       (orig: string, dest: string) => void
  feedback:     'idle' | 'thinking' | 'correct' | 'wrong'
  dests?:       Map<Key, Key[]>
  showDests?:   boolean
}

export function ChessBoard({ fen, orientation = 'white', turn = 'white', onMove, feedback, dests, showDests = false }: ChessBoardProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cgRef        = useRef<Api | null>(null)
  const onMoveRef    = useRef(onMove)
  onMoveRef.current  = onMove

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
    })
    return () => { cgRef.current?.destroy(); cgRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update whenever props change — single source of truth
  useEffect(() => {
    if (!cgRef.current) return
    cgRef.current.set({
      fen,
      orientation,
      turnColor: turn,
      movable: {
        color: feedback === 'idle' ? turn : undefined,
        dests: dests ?? new Map(),
        showDests,
      },
    })
  }, [fen, orientation, turn, feedback, dests, showDests])

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

import { useEffect } from 'react'

// ══ PromotionSelector ═════════════════════════════════════════════════════════
//
// Popup vertical Q/R/B/N sobre la casilla de destino, estilo Lichess. Se dibuja
// en un contenedor que envuelve al `<ChessBoard>`, en coordenadas relativas al
// tablero (0-100%). El padre le pasa la casilla de destino y el color del peón.
//
// Comportamiento:
//   - Click en una pieza → onChoose(piece)
//   - Click fuera / Escape → onCancel (la jugada se descarta y la pieza vuelve
//     al origen — el padre se encarga del snap-back cambiando la key/fen).
//
// Este componente NO decide si hay que promocionar. El padre debe evaluar la
// jugada del user (¿es un peón moviendo a la última fila?) y sólo entonces
// abrir el selector.

export type PromoPiece = 'q' | 'r' | 'b' | 'n'

interface Props {
  // Casilla de destino en notación algebraica (ej. 'e8'). Se usa para
  // calcular la columna del overlay. La fila se ignora: el stack siempre
  // baja o sube desde la fila 8 según el color.
  square:      string
  // Color del peón que promueve — determina la orientación del stack (blanco
  // baja de 8 a 5, negro sube de 1 a 4) y qué sprites mostrar.
  color:       'white' | 'black'
  // Orientación del tablero — necesaria para invertir columnas/filas cuando
  // el usuario está jugando con negras.
  orientation: 'white' | 'black'
  onChoose:    (piece: PromoPiece) => void
  onCancel:    () => void
}

// Símbolos Unicode — mismo estilo minimalista que el resto de la UI.
// Podríamos importar SVGs de chessground.cburnett pero por ahora esto alcanza.
const GLYPH: Record<'white'|'black', Record<PromoPiece, string>> = {
  white: { q: '♕', r: '♖', b: '♗', n: '♘' },
  black: { q: '♛', r: '♜', b: '♝', n: '♞' },
}

const ORDER: PromoPiece[] = ['q', 'r', 'b', 'n']

export function PromotionSelector({ square, color, orientation, onChoose, onCancel }: Props) {
  // Escape cancela
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const file = square.charCodeAt(0) - 'a'.charCodeAt(0)  // 0..7
  // Columna visual según orientación
  const col = orientation === 'white' ? file : 7 - file

  // El overlay se ancla arriba del tablero (top:0) para el color blanco
  // (promueve en fila 8, que arriba en orientación blanca) y abajo para
  // negro. Cuando el tablero está flipped invertimos también en Y.
  const stackFromTop = (color === 'white' && orientation === 'white')
                    || (color === 'black' && orientation === 'black')

  const leftPct = col * 12.5
  const startTopPct = stackFromTop ? 0 : 50
  // Cada pieza ocupa 1 casilla (12.5% del tablero); mostramos 4 piezas.

  return (
    <>
      {/* Backdrop transparente que captura clicks fuera */}
      <div
        onClick={onCancel}
        style={{
          position: 'absolute', inset: 0, zIndex: 20,
          background: 'rgba(0,0,0,0.35)', cursor: 'pointer',
        }}
      />
      {/* Stack de piezas */}
      <div style={{
        position: 'absolute',
        top:  `${startTopPct}%`,
        left: `${leftPct}%`,
        width:  '12.5%',
        height: '50%',
        zIndex: 21,
        display: 'flex',
        flexDirection: stackFromTop ? 'column' : 'column-reverse',
      }}>
        {ORDER.map(p => (
          <button
            key={p}
            onClick={(e) => { e.stopPropagation(); onChoose(p) }}
            aria-label={`Coronar ${p.toUpperCase()}`}
            style={{
              flex: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#f3ead6',
              border: '1px solid #9a8c6a',
              color: color === 'white' ? '#1a1a1a' : '#1a1a1a',
              fontSize: 'min(9vw, 60px)',
              lineHeight: 1,
              cursor: 'pointer',
              padding: 0,
              transition: 'background 0.1s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#fff6df' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#f3ead6' }}
          >
            {GLYPH[color][p]}
          </button>
        ))}
      </div>
    </>
  )
}

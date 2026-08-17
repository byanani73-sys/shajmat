// ─── Design tokens ────────────────────────────────────────────────────────────
// Shared entre App.tsx y las pantallas de features (WoodpeckerScreens.tsx, etc).
// Todo cambio de paleta se hace acá.

export const C = {
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
  // Info/análisis: usado cuando algo está "en pausa para revisar" (p.ej.
  // modo exploratorio del pájaro carpintero). Distinto del ámbar (activo)
  // y del rojo (error) para que quede claro que la sesión se pausó.
  info:      '#6b95d6',
  infoBg:    'rgba(107,149,214,0.12)',
  borderInfo:'rgba(107,149,214,0.35)',
  // Fondo especial para el modo exploratorio: azul oscuro sólido, distinto
  // del casi-negro del bg normal. Cambia el entorno entero para que la mente
  // registre "estoy en otro lugar" antes de leer un solo texto.
  exploringBg: '#0a1526',
  // Surface más elevada sobre el fondo azul (para cards en exploring).
  exploringSurface: '#122036',
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

export const mono   = { fontFamily: "'DM Mono', monospace" }
export const cinzel = { fontFamily: "'Cinzel', serif" }

// Formato mm:ss (usado por el timer de Storm y por el crono del woodpecker).
export const fmtTime = (s: number) => `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`

// Hook para detectar desktop vs mobile (breakpoint 768px). Compartido entre
// App.tsx y WoodpeckerScreens.tsx para tener el mismo umbral en toda la app.
import { useState, useEffect } from 'react'
export function useIsDesktop() {
  const [desktop, setDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 768 : true
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const fn = () => setDesktop(window.innerWidth >= 768)
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [])
  return desktop
}

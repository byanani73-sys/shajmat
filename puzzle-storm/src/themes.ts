// Curated Lichess puzzle themes + openings.
// Full list of Lichess themes: https://lichess.org/training/themes

export interface ThemeOption {
  id:       string        // Lichess tag canónico (el primero si hay aliases)
  label:    string        // Display name en español
  aliases?: string[]      // Tags adicionales que se unifican bajo esta UI entry (OR)
  count?:   number        // Puzzles disponibles en la DB al 2025-04
}

// Cada grupo matchea una prop de PuzzleFilters en lichess.ts.
// Comportamiento: OR dentro del grupo, AND entre grupos.
export type ThemeGroupKey =
  | 'mateThemes'
  | 'matePatterns'
  | 'tactics'
  | 'phases'
  | 'endgameTypes'
  | 'lengths'
  | 'evaluations'
  | 'openingTags'

export interface ThemeGroup {
  name:   string
  key:    ThemeGroupKey
  themes: ThemeOption[]
}

// Helper: devuelve todos los tags asociados a una opción (id + aliases).
export function themeTags(t: ThemeOption): string[] {
  return t.aliases && t.aliases.length > 0 ? [t.id, ...t.aliases] : [t.id]
}

// ═══ Temas tácticos ════════════════════════════════════════════════════════
export const THEME_GROUPS: ThemeGroup[] = [
  {
    name: 'Mates',
    key:  'mateThemes',
    themes: [
      { id: 'mateIn1', label: 'Mate en 1' },
      { id: 'mateIn2', label: 'Mate en 2' },
      { id: 'mateIn3', label: 'Mate en 3' },
      { id: 'mateIn4', label: 'Mate en 4' },
      { id: 'mate',    label: 'Mate (gral)' },
    ],
  },
  {
    name: 'Patrones de mate',
    key:  'matePatterns',
    themes: [
      { id: 'backRankMate',     label: 'Línea trasera' },
      { id: 'smotheredMate',    label: 'Ahogado' },
      { id: 'arabianMate',      label: 'Árabe' },
      { id: 'anastasiaMate',    label: 'Anastasia' },
      { id: 'bodenMate',        label: 'Boden' },
      { id: 'hookMate',         label: 'Gancho' },
      { id: 'dovetailMate',     label: 'Cola de pato' },
      { id: 'doubleBishopMate', label: 'Dos alfiles' },
      { id: 'vukovicMate',      label: 'Vukovic' },
      { id: 'killBoxMate',      label: 'Kill box' },
    ],
  },
  {
    name: 'Tácticas',
    key:  'tactics',
    themes: [
      { id: 'fork',             label: 'Horquilla' },
      { id: 'pin',              label: 'Clavada' },
      { id: 'skewer',           label: 'Ensarte' },
      { id: 'discoveredAttack', label: 'Descubierto' },
      { id: 'doubleCheck',      label: 'Jaque doble' },
      { id: 'sacrifice',        label: 'Sacrificio' },
      { id: 'deflection',       label: 'Desviación' },
      { id: 'attraction',       label: 'Atracción' },
      { id: 'hangingPiece',     label: 'Pieza colgada' },
      { id: 'trappedPiece',     label: 'Pieza atrapada' },
      { id: 'xRayAttack',       label: 'Rayos X' },
      { id: 'interference',     label: 'Interferencia' },
      { id: 'quietMove',        label: 'Jugada silenciosa' },
      { id: 'zugzwang',         label: 'Zugzwang' },
      { id: 'attackingF2F7',    label: 'Ataque a f2/f7' },
    ],
  },
  {
    name: 'Fase',
    key:  'phases',
    themes: [
      { id: 'opening',    label: 'Apertura' },
      { id: 'middlegame', label: 'Medio juego' },
      { id: 'endgame',    label: 'Final' },
    ],
  },
  {
    name: 'Finales',
    key:  'endgameTypes',
    themes: [
      { id: 'pawnEndgame',   label: 'De peones' },
      { id: 'rookEndgame',   label: 'De torre' },
      { id: 'queenEndgame',  label: 'De dama' },
      { id: 'bishopEndgame', label: 'De alfil' },
      { id: 'knightEndgame', label: 'De caballo' },
    ],
  },
  {
    name: 'Longitud',
    key:  'lengths',
    themes: [
      { id: 'oneMove',  label: '1 jugada' },
      { id: 'short',    label: '2 jugadas' },
      { id: 'long',     label: '3 jugadas' },
      { id: 'veryLong', label: '4+ jugadas' },
    ],
  },
  {
    name: 'Evaluación',
    key:  'evaluations',
    themes: [
      { id: 'advantage', label: 'Ventaja' },
      { id: 'crushing',  label: 'Aplastante' },
      { id: 'equality',  label: 'Igualdad' },
    ],
  },
]

// ═══ Aperturas ══════════════════════════════════════════════════════════════
// Umbral mínimo general: ≥50 puzzles. Excepciones: Smith-Morra y Colle-Zukertort
// (aperturas favoritas del usuario — se mantienen aunque tengan pool menor).
export interface OpeningGroup {
  name:     string
  openings: ThemeOption[]
}

export const OPENING_GROUPS: OpeningGroup[] = [
  {
    name: 'e4 con blancas',
    openings: [
      { id: 'Ruy_Lopez',                       label: 'Española',              count: 498 },
      { id: 'Ruy_Lopez_Berlin_Defense',        label: 'Española · Berlín',     count: 90  },
      { id: 'Italian_Game',                    label: 'Italiana',              count: 627 },
      { id: 'Italian_Game_Giuoco_Pianissimo',  label: 'Italiana · Pianissimo', count: 64  },
      { id: 'Scotch_Game',                     label: 'Escocesa',              count: 506 },
      { id: 'Scotch_Game_Scotch_Gambit',       label: 'Gambito escocés',       count: 143, aliases: ['Italian_Game_Scotch_Gambit'] },
      { id: 'Kings_Gambit',                    label: 'Gambito de rey',        count: 451 },
      { id: 'Vienna_Game',                     label: 'Vienesa',               count: 459 },
      { id: 'Bishops_Opening',                 label: 'De alfil',              count: 86  },
      { id: 'Kings_Pawn_Game',                 label: 'Peón de rey (gral)',    count: 77  },
    ],
  },
  {
    name: 'vs Siciliana',
    openings: [
      { id: 'Sicilian_Defense_Alapin_Variation',   label: 'Alapin',      count: 85 },
      { id: 'Sicilian_Defense_Closed',             label: 'Cerrada',     count: 76 },
      { id: 'Sicilian_Defense_Smith-Morra_Gambit', label: 'Smith-Morra', count: 28 },
    ],
  },
  {
    name: 'd4 con blancas',
    openings: [
      { id: 'Queens_Gambit',                         label: 'Gambito de dama',  count: 304 },
      { id: 'Queens_Gambit_Declined',                label: 'GD Declinado',     count: 212 },
      { id: 'Queens_Gambit_Accepted',                label: 'GD Aceptado',      count: 52  },
      { id: 'London_System',                         label: 'Sistema Londres',  count: 430 },
      { id: 'Queens_Pawn_Game_Colle_System',         label: 'Sistema Colle',    count: 43  },
      { id: 'Queens_Pawn_Game_Zukertort_Variation',  label: 'Colle-Zukertort',  count: 27  },
      { id: 'Catalan_Opening',                       label: 'Catalana',         count: 440 },
    ],
  },
  {
    name: 'Otras con blancas',
    openings: [
      { id: 'English_Opening', label: 'Inglesa', count: 519 },
      { id: 'Reti_Opening',    label: 'Réti',    count: 434 },
      { id: 'Bird_Opening',    label: 'Bird',    count: 78  },
    ],
  },
  {
    name: 'Defensas vs e4',
    openings: [
      { id: 'Sicilian_Defense',                 label: 'Siciliana',          count: 1069 },
      { id: 'French_Defense',                   label: 'Francesa',           count: 644  },
      { id: 'French_Defense_Advance_Variation', label: 'Francesa · Avance',  count: 97   },
      { id: 'Caro-Kann_Defense',                label: 'Caro-Kann',          count: 702  },
      { id: 'Scandinavian_Defense',             label: 'Escandinava',        count: 621  },
      { id: 'Pirc_Defense',                     label: 'Pirc',               count: 455  },
      { id: 'Alekhine_Defense',                 label: 'Alekhine',           count: 455  },
      { id: 'Modern_Defense',                   label: 'Moderna',            count: 70   },
    ],
  },
  {
    name: 'Defensas vs d4',
    openings: [
      { id: 'Kings_Indian_Defense',  label: 'India de Rey',  count: 451 },
      { id: 'Nimzo-Indian_Defense',  label: 'Nimzo-India',   count: 450 },
      { id: 'Queens_Indian_Defense', label: 'India de Dama', count: 427 },
      { id: 'Grunfeld_Defense',      label: 'Grünfeld',      count: 450 },
      { id: 'Slav_Defense',          label: 'Eslava',        count: 460 },
      { id: 'Dutch_Defense',         label: 'Holandesa',     count: 454 },
      { id: 'Benoni_Defense',        label: 'Benoni',        count: 453 },
    ],
  },
]

export const ALL_OPENINGS: ThemeOption[] = OPENING_GROUPS.flatMap(g => g.openings)
export const ALL_THEMES:   ThemeOption[] = THEME_GROUPS.flatMap(g => g.themes)

// ═══ Filter builder ═════════════════════════════════════════════════════════
// Combina la selección plana del UI en los grupos correctos para el RPC.
// - Temas: van al grupo correspondiente según THEME_GROUPS
// - Aperturas: todas van a openingTags (con expansión de aliases)
export function buildFiltersFromSelection(
  selectedThemeIds:   string[],
  selectedOpeningIds: string[] = [],
): Record<ThemeGroupKey, string[]> {
  const byKey: Record<ThemeGroupKey, string[]> = {
    mateThemes: [], matePatterns: [], tactics: [], phases: [],
    endgameTypes: [], lengths: [], evaluations: [], openingTags: [],
  }

  // Temas
  for (const id of selectedThemeIds) {
    for (const g of THEME_GROUPS) {
      const opt = g.themes.find(t => t.id === id)
      if (opt) {
        byKey[g.key].push(...themeTags(opt))
        break
      }
    }
  }

  // Aperturas (expandir aliases)
  for (const id of selectedOpeningIds) {
    const op = ALL_OPENINGS.find(o => o.id === id)
    if (op) byKey.openingTags.push(...themeTags(op))
  }

  return byKey
}

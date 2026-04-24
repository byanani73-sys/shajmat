import { Chess }    from 'chess.js'
import { LICHESS }  from './auth'
import { supabase } from './supabase'

// ── Types ─────────────────────────────────────────────────────────────────────
export interface LichessUser {
  id: string; username: string
  perfs: { puzzle: { rating: number; rd: number; prog: number; prov?: boolean } }
}

export interface Puzzle {
  id: string; rating: number; theme: string
  fen: string; turn: 'white' | 'black'
  solution: string[]
}

interface SupabasePuzzle {
  id: string; fen: string; solution: string[]
  rating: number; rating_deviation: number; popularity: number
  themes: string[]; opening_tags: string[] | null
}

export interface PuzzleFilters {
  // Cada grupo es OR interno; AND entre grupos.
  mateThemes?:    string[]  // mateIn1, mateIn2, ...
  matePatterns?:  string[]  // backRankMate, smotheredMate, ...
  tactics?:       string[]  // fork, pin, sacrifice, ...
  phases?:        string[]  // opening, middlegame, endgame
  endgameTypes?:  string[]  // rookEndgame, pawnEndgame, ...
  lengths?:       string[]  // oneMove, short, long, veryLong
  evaluations?:   string[]  // advantage, crushing, equality
  openingTags?:   string[]  // Italian_Game, Sicilian_Defense, ...
  minRating?:     number
  maxRating?:     number
}

// ── User fetch (sigue en Lichess — 1 call por sesión) ────────────────────────
export async function fetchUser(token: string): Promise<LichessUser> {
  const res = await fetch(`${LICHESS}/api/account`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Lichess ${res.status}: ${res.statusText}`)
  return res.json()
}

// ── Theme labels ──────────────────────────────────────────────────────────────
const THEMES: Record<string, string> = {
  mateIn1: 'Mate en 1', mateIn2: 'Mate en 2', mateIn3: 'Mate en 3', mateIn4: 'Mate en 4',
  mate: 'Mate', fork: 'Horquilla', pin: 'Clavada', skewer: 'Ensarte',
  discoveredAttack: 'Ataque al descubierto', doubleCheck: 'Jaque doble',
  backRankMate: 'Línea trasera', sacrifice: 'Sacrificio',
  deflection: 'Desviación', attraction: 'Atracción',
  clearance: 'Apertura de línea', interference: 'Interferencia',
  quietMove: 'Jugada silenciosa', zugzwang: 'Zugzwang',
  rookEndgame: 'Final de torre', queenEndgame: 'Final de dama',
  bishopEndgame: 'Final de alfil', knightEndgame: 'Final de caballo',
  pawnEndgame: 'Final de peones', endgame: 'Final',
  opening: 'Apertura', middlegame: 'Medio juego',
  crushing: 'Jugada devastadora', hangingPiece: 'Pieza colgada',
  capturingDefender: 'Captura del defensor', trappedPiece: 'Pieza atrapada',
  advancedPawn: 'Peón avanzado', promotion: 'Coronación',
  short: 'Táctica corta', long: 'Táctica larga',
  advantage: 'Ventaja', equality: 'Igualdad',
}

const PRIORITY = ['mateIn1','mateIn2','mateIn3','mateIn4','mate','fork','pin','skewer','backRankMate','discoveredAttack','doubleCheck','sacrifice','deflection','attraction']

function themeLabel(themes: string[]): string {
  for (const p of PRIORITY) if (themes.includes(p)) return THEMES[p]
  for (const t of themes) if (THEMES[t]) return THEMES[t]
  return themes[0] ?? 'Táctica'
}

// ── Errors ────────────────────────────────────────────────────────────────────
export class NoPuzzlesFoundError extends Error {
  constructor(msg = 'no_puzzles') { super(msg) }
}

// ── Row crudo → Puzzle listo para usar ────────────────────────────────────────
function toPuzzle(row: SupabasePuzzle): Puzzle {
  const turn = row.fen.split(' ')[1] === 'w' ? 'white' : 'black'
  return {
    id:       row.id,
    rating:   row.rating,
    theme:    themeLabel(row.themes),
    fen:      row.fen,
    turn,
    solution: row.solution,
  }
}

// Helper: convierte array vacío a null para que el RPC lo ignore
const nn = (a?: string[]) => (a && a.length > 0 ? a : null)

// ── Fetch con filtros ─────────────────────────────────────────────────────────
export async function fetchNextPuzzle(
  filters: PuzzleFilters = {},
  excludeIds: string[] = [],
): Promise<Puzzle> {
  const { data, error } = await supabase.rpc('get_random_puzzle', {
    mate_themes:     nn(filters.mateThemes),
    mate_patterns:   nn(filters.matePatterns),
    tactics:         nn(filters.tactics),
    phases:          nn(filters.phases),
    endgame_types:   nn(filters.endgameTypes),
    lengths:         nn(filters.lengths),
    evaluations:     nn(filters.evaluations),
    openings_filter: nn(filters.openingTags),
    min_rating:      filters.minRating ?? 400,
    max_rating:      filters.maxRating ?? 3000,
    exclude_ids:     excludeIds,
  })

  if (error) throw new Error(`Supabase: ${error.message}`)
  if (!data || data.length === 0) throw new NoPuzzlesFoundError()

  const row = data[0] as SupabasePuzzle
  try { new Chess(row.fen) }
  catch { throw new Error(`FEN inválido en puzzle ${row.id}`) }

  return toPuzzle(row)
}

// ── Contar puzzles disponibles (UI feedback) ─────────────────────────────────
export async function countPuzzles(filters: PuzzleFilters = {}): Promise<number> {
  const { data, error } = await supabase.rpc('count_puzzles_matching', {
    mate_themes:     nn(filters.mateThemes),
    mate_patterns:   nn(filters.matePatterns),
    tactics:         nn(filters.tactics),
    phases:          nn(filters.phases),
    endgame_types:   nn(filters.endgameTypes),
    lengths:         nn(filters.lengths),
    evaluations:     nn(filters.evaluations),
    openings_filter: nn(filters.openingTags),
    min_rating:      filters.minRating ?? 400,
    max_rating:      filters.maxRating ?? 3000,
  })
  if (error) throw new Error(`Supabase: ${error.message}`)
  return data ?? 0
}

// ── Queue con prefetching + reciclado ────────────────────────────────────────
export class PuzzleQueue {
  private queue: Puzzle[] = []
  private fetching = false
  private filters: PuzzleFilters
  private seenIds: string[] = []
  private onError?: (err: Error) => void
  private recycleAfter = 200

  constructor(filters: PuzzleFilters = {}, onError?: (err: Error) => void) {
    this.filters = filters
    this.onError = onError
  }

  private async fetchOne(): Promise<Puzzle> {
    const excludeIds = this.seenIds.length > this.recycleAfter ? [] : this.seenIds
    try {
      return await fetchNextPuzzle(this.filters, excludeIds)
    } catch (e) {
      if (e instanceof NoPuzzlesFoundError && this.seenIds.length > 0) {
        this.seenIds = []
        return fetchNextPuzzle(this.filters, [])
      }
      throw e
    }
  }

  async fill(): Promise<void> {
    if (this.fetching || this.queue.length >= 1) return
    this.fetching = true
    try {
      const p = await this.fetchOne()
      this.queue.push(p)
    } catch (e) {
      this.onError?.(e as Error)
    } finally {
      this.fetching = false
    }
  }

  async next(): Promise<Puzzle> {
    let p: Puzzle
    if (this.queue.length > 0) p = this.queue.shift()!
    else                       p = await this.fetchOne()
    this.seenIds.push(p.id)
    this.fill()
    return p
  }
}

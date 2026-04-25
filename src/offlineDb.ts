// IndexedDB layer para puzzles offline.
// Sin librerías externas — usa la API nativa.

import type { Puzzle, PuzzleFilters } from './lichess'
import type { SessionRecord } from './sessions'

const DB_NAME    = 'shajmat-offline'
const DB_VERSION = 2  // v2: agrega store pending_sessions (outbox)
const PUZZLE_STORE  = 'puzzles'
const META_STORE    = 'meta'
const PENDING_STORE = 'pending_sessions'
const META_INITIAL_DONE = 'initial_download_done'

// Estructura cruda guardada en IndexedDB (mirror de la tabla puzzles + random_seed local)
export interface OfflinePuzzleRow {
  id:               string
  fen:              string
  solution:         string[]
  rating:           number
  rating_deviation: number
  popularity:       number
  themes:           string[]
  opening_tags:     string[] | null
  random_seed:      number
}

// Selección de label de tema (idéntica a la de lichess.ts pero local
// para evitar coupling — si themes.ts/lichess.ts cambian, mover esto a un módulo común)
const THEMES: Record<string, string> = {
  mateIn1:'Mate en 1',mateIn2:'Mate en 2',mateIn3:'Mate en 3',mateIn4:'Mate en 4',
  mate:'Mate',fork:'Horquilla',pin:'Clavada',skewer:'Ensarte',
  discoveredAttack:'Ataque al descubierto',doubleCheck:'Jaque doble',
  backRankMate:'Línea trasera',sacrifice:'Sacrificio',
  deflection:'Desviación',attraction:'Atracción',
  clearance:'Apertura de línea',interference:'Interferencia',
  quietMove:'Jugada silenciosa',zugzwang:'Zugzwang',
  rookEndgame:'Final de torre',queenEndgame:'Final de dama',
  bishopEndgame:'Final de alfil',knightEndgame:'Final de caballo',
  pawnEndgame:'Final de peones',endgame:'Final',
  opening:'Apertura',middlegame:'Medio juego',
  crushing:'Jugada devastadora',hangingPiece:'Pieza colgada',
  capturingDefender:'Captura del defensor',trappedPiece:'Pieza atrapada',
  advancedPawn:'Peón avanzado',promotion:'Coronación',
  short:'Táctica corta',long:'Táctica larga',
  advantage:'Ventaja',equality:'Igualdad',
}
const PRIORITY = ['mateIn1','mateIn2','mateIn3','mateIn4','mate','fork','pin','skewer','backRankMate','discoveredAttack','doubleCheck','sacrifice','deflection','attraction']

function themeLabel(themes: string[]): string {
  for (const p of PRIORITY) if (themes.includes(p)) return THEMES[p]
  for (const t of themes) if (THEMES[t]) return THEMES[t]
  return themes[0] ?? 'Táctica'
}

function rowToPuzzle(row: OfflinePuzzleRow): Puzzle {
  return {
    id:       row.id,
    rating:   row.rating,
    theme:    themeLabel(row.themes),
    fen:      row.fen,
    turn:     row.fen.split(' ')[1] === 'w' ? 'white' : 'black',
    solution: row.solution,
  }
}

// ─── Open DB (singleton lazy) ────────────────────────────────────────────────
let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB no disponible'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(PUZZLE_STORE)) {
        const store = db.createObjectStore(PUZZLE_STORE, { keyPath: 'id' })
        store.createIndex('rating',      'rating',      { unique: false })
        store.createIndex('random_seed', 'random_seed', { unique: false })
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' })
      }
      // v2: outbox de sesiones para reenviar al recuperar conexión
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        db.createObjectStore(PENDING_STORE, { keyPath: 'local_id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
  return dbPromise
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function tx<T>(storeName: string, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode)
    const store       = transaction.objectStore(storeName)
    const req         = op(store)
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  }))
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Guarda un batch de puzzles. Sobreescribe si ya existen (upsert por id).
 * Asigna random_seed automáticamente si la fila no lo trae.
 */
export async function savePuzzles(rows: Omit<OfflinePuzzleRow, 'random_seed'>[]): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PUZZLE_STORE, 'readwrite')
    const store       = transaction.objectStore(PUZZLE_STORE)
    for (const row of rows) {
      store.put({ ...row, random_seed: Math.random() })
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror    = () => reject(transaction.error)
  })
}

/** Devuelve la cantidad total de puzzles offline. */
export async function countOfflinePuzzles(): Promise<number> {
  return tx(PUZZLE_STORE, 'readonly', s => s.count())
}

/** Devuelve un Set con todos los IDs offline (para evitar redescargar). */
export async function getOfflinePuzzleIds(): Promise<Set<string>> {
  const ids = await tx<IDBValidKey[]>(PUZZLE_STORE, 'readonly', s => s.getAllKeys())
  return new Set(ids as string[])
}

/**
 * Selecciona un puzzle random matching los filtros.
 * Estrategia: range-scan por rating + filtrado in-memory + random pick.
 * Performance: O(n) donde n = puzzles en el rango de rating.
 * Para 5k-20k puzzles totales esto es <100ms — aceptable como fallback offline.
 */
export async function getRandomPuzzleOffline(
  filters: PuzzleFilters = {},
  excludeIds: string[] = [],
): Promise<Puzzle | null> {
  const minRating = filters.minRating ?? 400
  const maxRating = filters.maxRating ?? 3000
  const exclude   = new Set(excludeIds)

  // Combinar todos los filtros de tema en un único array (OR semantics dentro y entre grupos
  // como se hace en el RPC del server — cualquier match cuenta)
  const allThemeFilters = [
    ...(filters.mateThemes    ?? []),
    ...(filters.matePatterns  ?? []),
    ...(filters.tactics       ?? []),
    ...(filters.phases        ?? []),
    ...(filters.endgameTypes  ?? []),
    ...(filters.lengths       ?? []),
    ...(filters.evaluations   ?? []),
  ]
  const openingFilters = filters.openingTags ?? []
  const hasThemeFilter   = allThemeFilters.length > 0
  const hasOpeningFilter = openingFilters.length > 0

  const matches: OfflinePuzzleRow[] = []
  const db = await openDb()

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(PUZZLE_STORE, 'readonly')
    const store       = transaction.objectStore(PUZZLE_STORE)
    const index       = store.index('rating')
    const range       = IDBKeyRange.bound(minRating, maxRating)
    const req         = index.openCursor(range)

    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result
      if (!cursor) { resolve(); return }
      const row = cursor.value as OfflinePuzzleRow

      if (exclude.has(row.id)) { cursor.continue(); return }
      if (hasThemeFilter   && !row.themes.some(t => allThemeFilters.includes(t)))           { cursor.continue(); return }
      if (hasOpeningFilter && !(row.opening_tags ?? []).some(o => openingFilters.includes(o))) { cursor.continue(); return }

      matches.push(row)
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })

  if (matches.length === 0) return null
  return rowToPuzzle(matches[Math.floor(Math.random() * matches.length)])
}

// ─── Meta (flags persistentes) ───────────────────────────────────────────────
export async function isInitialDownloadDone(): Promise<boolean> {
  const row = await tx<{ key: string; value: boolean } | undefined>(META_STORE, 'readonly', s => s.get(META_INITIAL_DONE))
  return row?.value === true
}

export async function markInitialDownloadDone(): Promise<void> {
  await tx(META_STORE, 'readwrite', s => s.put({ key: META_INITIAL_DONE, value: true }))
}

// ─── Outbox de sesiones (para sync al recuperar conexión) ────────────────────
//
// Cuando saveSession() falla offline, encolamos la sesión completa acá.
// El offlineOutbox.ts las reintenta al detectar 'online' y al arrancar la app.
export interface PendingSession {
  local_id:       string         // UUID local para tracking en el outbox
  session:        SessionRecord  // los datos a subir (incluye un id explícito para idempotencia)
  err_puzzle_ids: string[]
  created_at:     number
}

export async function queuePendingSession(session: SessionRecord, errPuzzleIds: string[]): Promise<void> {
  const entry: PendingSession = {
    local_id:       (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
    session,
    err_puzzle_ids: errPuzzleIds,
    created_at:     Date.now(),
  }
  await tx(PENDING_STORE, 'readwrite', s => s.put(entry))
}

export async function getPendingSessions(): Promise<PendingSession[]> {
  const rows = await tx<PendingSession[]>(PENDING_STORE, 'readonly', s => s.getAll())
  return rows ?? []
}

export async function removePendingSession(localId: string): Promise<void> {
  await tx(PENDING_STORE, 'readwrite', s => s.delete(localId))
}

export async function countPendingSessions(): Promise<number> {
  return tx(PENDING_STORE, 'readonly', s => s.count())
}

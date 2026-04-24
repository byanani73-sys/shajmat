#!/usr/bin/env python3
"""
Shajmat — Import Lichess puzzles to Supabase.

Workflow:
1. Download the Lichess puzzle DB (CSV.zst) if not present
2. Decompress and read
3. Filter by quality (popularity, rating deviation)
4. Stratify: top N puzzles per (theme × rating bucket) + general pool
5. Apply the setup move to each FEN to get the puzzle starting position
6. Deduplicate and bulk upsert to Supabase

Usage:
  python import_puzzles.py

Requirements:
  .env file with SUPABASE_URL and SUPABASE_SERVICE_KEY
"""

import os
import sys
import csv
import urllib.request
from pathlib import Path
from collections import defaultdict, Counter

import chess
import zstandard as zstd
from dotenv import load_dotenv
from supabase import create_client
from tqdm import tqdm


# ═══ Config ════════════════════════════════════════════════════════════════

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit(
        "Error: faltan SUPABASE_URL y/o SUPABASE_SERVICE_KEY en .env\n"
        "Copiá .env.example a .env y pegá tus credenciales."
    )

LICHESS_DB_URL    = "https://database.lichess.org/lichess_db_puzzle.csv.zst"
COMPRESSED_PATH   = Path("lichess_db_puzzle.csv.zst")
DECOMPRESSED_PATH = Path("lichess_db_puzzle.csv")

# Filtros de calidad — solo puzzles bien valorados y con rating estable
MIN_POPULARITY       = 80    # 80 sobre 100 = bien valorado
MAX_RATING_DEVIATION = 100   # rating estable (el default de Lichess es 500)

# Buckets de rating para estratificación
RATING_BUCKETS = [
    (400, 999), (1000, 1199), (1200, 1399), (1400, 1599),
    (1600, 1799), (1800, 1999), (2000, 2199), (2200, 2399), (2400, 3500),
]
TOP_PER_BUCKET = 50      # top N más populares por (tema × bucket)
GENERAL_POOL   = 20_000  # pool adicional de puzzles populares sin filtro de tema

# Temas a estratificar — matchea THEME_GROUPS de themes.ts
STRATIFY_THEMES = [
    # Mates
    'mateIn1', 'mateIn2', 'mateIn3', 'mateIn4', 'mate',
    # Patrones de mate
    'backRankMate', 'smotheredMate', 'arabianMate', 'anastasiaMate',
    'bodenMate', 'hookMate', 'dovetailMate', 'doubleBishopMate',
    'vukovicMate', 'killBoxMate',
    # Tácticas
    'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck',
    'sacrifice', 'deflection', 'attraction', 'hangingPiece', 'trappedPiece',
    'xRayAttack', 'interference', 'quietMove', 'zugzwang', 'attackingF2F7',
    # Fase
    'opening', 'middlegame', 'endgame',
    # Finales
    'pawnEndgame', 'rookEndgame', 'queenEndgame', 'bishopEndgame', 'knightEndgame',
    # Longitud
    'oneMove', 'short', 'long', 'veryLong',
    # Evaluación
    'advantage', 'crushing', 'equality',
]

# Aperturas (campo separado del CSV: OpeningTags)
STRATIFY_OPENINGS = [
    # Blancas
    'Italian_Game', 'Ruy_Lopez', 'Scotch_Game', 'Vienna_Game',
    'Kings_Gambit', 'Queens_Gambit', 'English_Opening', 'London_System',
    'Reti_Opening', 'Catalan_Opening',
    # Negras
    'Sicilian_Defense', 'French_Defense', 'Caro-Kann_Defense',
    'Scandinavian_Defense', 'Pirc_Defense', 'Alekhine_Defense',
    'Kings_Indian_Defense', 'Nimzo-Indian_Defense', 'Queens_Indian_Defense',
    'Grunfeld_Defense', 'Slav_Defense', 'Dutch_Defense', 'Benoni_Defense',
]

BATCH_SIZE = 500  # puzzles por request a Supabase


# ═══ Descarga ═════════════════════════════════════════════════════════════════

def download_if_needed():
    if COMPRESSED_PATH.exists():
        size_mb = COMPRESSED_PATH.stat().st_size / 1_000_000
        print(f"✓ {COMPRESSED_PATH} ya existe ({size_mb:.1f} MB)")
        return

    print(f"Descargando {LICHESS_DB_URL} (~300 MB)...")
    with urllib.request.urlopen(LICHESS_DB_URL) as response:
        total = int(response.headers.get('Content-Length', 0))
        with tqdm(total=total, unit='B', unit_scale=True, desc='Descargando') as pbar:
            with open(COMPRESSED_PATH, 'wb') as f:
                while chunk := response.read(8192):
                    f.write(chunk)
                    pbar.update(len(chunk))
    print("✓ Descarga completa")


def decompress_if_needed():
    if DECOMPRESSED_PATH.exists():
        size_mb = DECOMPRESSED_PATH.stat().st_size / 1_000_000
        print(f"✓ {DECOMPRESSED_PATH} ya existe ({size_mb:.1f} MB)")
        return

    print(f"Descomprimiendo {COMPRESSED_PATH} (~1.5 GB descomprimido)...")
    dctx = zstd.ZstdDecompressor()
    with open(COMPRESSED_PATH, 'rb') as src, open(DECOMPRESSED_PATH, 'wb') as dst:
        dctx.copy_stream(src, dst)
    print("✓ Descompresión completa")


# ═══ Procesamiento de puzzles ════════════════════════════════════════════════

def process_puzzle(row: dict):
    """
    Convierte una fila CSV en un dict de puzzle listo para insertar.
    Aplica el setup move al FEN (el primer move del CSV es del rival).
    Retorna None si el puzzle es inválido.
    """
    try:
        moves = row['Moves'].split()
        if len(moves) < 2:  # necesita setup move + al menos 1 de solución
            return None

        board = chess.Board(row['FEN'])
        setup_move = chess.Move.from_uci(moves[0])
        if setup_move not in board.legal_moves:
            return None
        board.push(setup_move)

        opening_raw = row.get('OpeningTags', '')
        opening_tags = opening_raw.split() if opening_raw else None

        return {
            'id':               row['PuzzleId'],
            'fen':              board.fen(),
            'solution':         moves[1:],
            'rating':           int(row['Rating']),
            'rating_deviation': int(row['RatingDeviation']),
            'popularity':       int(row['Popularity']),
            'themes':           row['Themes'].split() if row['Themes'] else [],
            'opening_tags':     opening_tags,
        }
    except (ValueError, KeyError, chess.InvalidMoveError):
        return None


def bucket_for_rating(rating: int) -> int:
    for i, (lo, hi) in enumerate(RATING_BUCKETS):
        if lo <= rating <= hi:
            return i
    return len(RATING_BUCKETS) - 1


def select_puzzles() -> list[dict]:
    """
    Lee el CSV, filtra, estratifica, deduplica.
    Retorna la lista final de puzzles únicos a subir.
    """
    # Claves: (theme_or_opening_tag, bucket_idx) → lista de (-popularity, puzzle)
    # Negamos popularity para que sort ascendente ponga los más populares primero
    buckets = defaultdict(list)
    general_pool = []

    total = 0
    kept = 0

    print("\nContando filas del CSV...")
    with open(DECOMPRESSED_PATH, 'r', encoding='utf-8') as f:
        total_rows = sum(1 for _ in f) - 1  # -1 por el header
    print(f"  {total_rows:,} filas en total")

    print("Procesando puzzles...")
    with open(DECOMPRESSED_PATH, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in tqdm(reader, total=total_rows, desc="Procesando", unit='puzzles'):
            total += 1

            try:
                # Campos numéricos pueden estar vacíos en filas corruptas
                popularity = int(row['Popularity']) if row.get('Popularity') else None
                rd         = int(row['RatingDeviation']) if row.get('RatingDeviation') else None
                rating     = int(row['Rating']) if row.get('Rating') else None
                if popularity is None or rd is None or rating is None:
                    continue
            except (ValueError, KeyError):
                continue

            if popularity < MIN_POPULARITY or rd > MAX_RATING_DEVIATION:
                continue

            puzzle = process_puzzle(row)
            if not puzzle:
                continue

            kept += 1
            bucket = bucket_for_rating(rating)
            entry = (-popularity, puzzle['id'], puzzle)  # tuple para sort estable

            for theme in puzzle['themes']:
                if theme in STRATIFY_THEMES:
                    buckets[(f"theme:{theme}", bucket)].append(entry)

            for opening in (puzzle['opening_tags'] or []):
                if opening in STRATIFY_OPENINGS:
                    buckets[(f"opening:{opening}", bucket)].append(entry)

            general_pool.append(entry)

    print(f"\n✓ Procesadas {total:,} filas")
    print(f"  {kept:,} pasaron los filtros de calidad (popularity ≥ {MIN_POPULARITY}, rd ≤ {MAX_RATING_DEVIATION})")

    # Seleccionar top N por (tema × bucket)
    selected: dict[str, dict] = {}
    for (_key, _bucket), entries in buckets.items():
        entries.sort()  # más populares primero (porque guardamos -popularity)
        for _, _pid, puzzle in entries[:TOP_PER_BUCKET]:
            selected[puzzle['id']] = puzzle

    # Sumar pool general
    general_pool.sort()
    for _, _pid, puzzle in general_pool[:GENERAL_POOL]:
        selected[puzzle['id']] = puzzle

    result = list(selected.values())
    print(f"  {len(result):,} puzzles únicos seleccionados tras deduplicación\n")
    return result


# ═══ Upload a Supabase ═══════════════════════════════════════════════════════

def upload(puzzles: list[dict]):
    print(f"Subiendo {len(puzzles):,} puzzles a Supabase...")
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

    with tqdm(total=len(puzzles), desc="Subiendo", unit='puzzles') as pbar:
        for i in range(0, len(puzzles), BATCH_SIZE):
            batch = puzzles[i:i+BATCH_SIZE]
            try:
                supabase.table('puzzles').upsert(batch).execute()
            except Exception as e:
                print(f"\n⚠ Error en batch {i}-{i+len(batch)}: {e}")
                raise
            pbar.update(len(batch))

    print("✓ Upload completo")


# ═══ Preview de stats ════════════════════════════════════════════════════════

def print_preview(puzzles: list[dict]):
    print("\n─── Preview del set seleccionado ────────────────────────")

    # Distribución por tema
    theme_count = Counter()
    for p in puzzles:
        for t in p['themes']:
            theme_count[t] += 1

    print("\nTop 15 temas por frecuencia:")
    for theme, count in theme_count.most_common(15):
        print(f"  {theme:25} {count:>6,}")

    # Distribución por bucket de rating
    bucket_count = Counter()
    for p in puzzles:
        bucket_count[bucket_for_rating(p['rating'])] += 1

    print("\nDistribución por rating:")
    for i, (lo, hi) in enumerate(RATING_BUCKETS):
        count = bucket_count.get(i, 0)
        bar = '█' * int(count / max(bucket_count.values()) * 30) if bucket_count else ''
        print(f"  {lo:4}-{hi:4}  {count:>6,}  {bar}")

    # Coverage de aperturas
    opening_count = Counter()
    for p in puzzles:
        for o in (p['opening_tags'] or []):
            if o in STRATIFY_OPENINGS:
                opening_count[o] += 1

    print(f"\nTop 10 aperturas (de {len(STRATIFY_OPENINGS)} trackeadas):")
    for opening, count in opening_count.most_common(10):
        print(f"  {opening:30} {count:>6,}")

    print(f"\n  Total: {len(puzzles):,} puzzles únicos")


# ═══ Main ════════════════════════════════════════════════════════════════════

def main():
    download_if_needed()
    decompress_if_needed()
    puzzles = select_puzzles()
    print_preview(puzzles)

    print("\n───────────────────────────────────────────────────────────")
    confirm = input(f"¿Subir {len(puzzles):,} puzzles a Supabase? [y/N]: ")
    if confirm.lower() != 'y':
        print("Cancelado.")
        return

    upload(puzzles)
    print(f"\n🎉 ¡Listo! {len(puzzles):,} puzzles en Supabase.")
    print("\nVerificá en Supabase → Table Editor → puzzles")
    print("\nPodés borrar los archivos CSV locales para liberar espacio:")
    print(f"  rm {COMPRESSED_PATH} {DECOMPRESSED_PATH}")


if __name__ == '__main__':
    main()

# Shajmat — Import de puzzles a Supabase

Este script descarga la base de datos pública de puzzles de Lichess, la filtra
por calidad, estratifica por tema × rating para asegurar coverage en todas las
categorías, y sube el resultado a tu Supabase.

## Qué hace

1. Descarga el CSV comprimido de Lichess (~300MB)
2. Lo descomprime (~1.5GB, 5.9M puzzles)
3. Filtra por calidad: popularidad ≥ 80, rating deviation ≤ 100
4. Estratifica: top 50 puzzles por (tema × rating bucket) para 45 temas + 23 aperturas × 9 buckets
5. Agrega un pool general de 20K puzzles populares sin filtro
6. Aplica el setup move a cada FEN (primer movimiento es del rival)
7. Deduplica (un puzzle aparece en múltiples categorías)
8. Sube a Supabase con upsert

**Resultado esperado:** entre 40K y 80K puzzles únicos. Todos los temas con
coverage en todos los rangos de rating.

## Requisitos

- Python 3.9+
- ~2GB de disco libre (CSV descomprimido, borrable después)
- Credenciales de Supabase (URL y service_role key)

## Setup (primera vez)

Abrí una terminal dentro de esta carpeta y corré:

```bash
# 1. Crear virtualenv (recomendado pero opcional)
python3 -m venv venv
source venv/bin/activate       # macOS/Linux
# o en Windows:  venv\Scripts\activate

# 2. Instalar dependencias
pip install -r requirements.txt

# 3. Crear archivo .env con tus credenciales
cp .env.example .env
# Abrí .env con tu editor y pegá:
#   - SUPABASE_URL: la URL del proyecto (Settings → API → Project URL)
#   - SUPABASE_SERVICE_KEY: la key que dice "service_role (secret)"
```

⚠ **Importante:** la `service_role key` bypassa RLS. Nunca la subas a Git.
El archivo `.env` debería quedar solo en tu máquina.

## Correr

```bash
python import_puzzles.py
```

Qué vas a ver, en orden:

1. **Descarga** del CSV con progress bar (~1-3 min según conexión)
2. **Descompresión** (~30 segundos)
3. **Procesamiento** con progress bar (~1-2 min para las 5.9M filas)
4. **Preview de stats** con:
   - Top 15 temas del set seleccionado
   - Distribución visual por rating
   - Top 10 aperturas con coverage
   - Total de puzzles
5. **Confirmación** antes de subir (escribí `y` + Enter)
6. **Upload** con progress bar (~3-5 min para ~60K puzzles)

Tiempo total estimado: **10-15 minutos** para toda la secuencia.

## Verificar que funcionó

Andá a Supabase → Table Editor → `puzzles`. Deberías ver la cuenta arriba a
la derecha. También podés correr esto en el SQL Editor:

```sql
SELECT COUNT(*) FROM puzzles;
SELECT unnest(themes) AS theme, COUNT(*)
  FROM puzzles GROUP BY theme ORDER BY COUNT(*) DESC LIMIT 20;
```

## Limpieza (opcional)

Una vez subido todo, podés borrar los archivos CSV para liberar espacio:

```bash
rm lichess_db_puzzle.csv*
```

## Re-correr más tarde

Lichess actualiza la DB de vez en cuando (cada par de meses). Para refrescar:

```bash
rm lichess_db_puzzle.csv*    # borrar archivos viejos
python import_puzzles.py     # bajar y reimportar
```

El script hace `upsert`, así que puzzles existentes se actualizan con los
datos nuevos (ratings revisados, popularidad actualizada) y los nuevos se
insertan. No hay duplicados.

## Troubleshooting

**"Connection refused" o timeout al subir:** chequeá que la SUPABASE_URL y la
SERVICE_KEY estén bien copiadas en .env. La service key es muy larga (~200
chars) — asegurate de copiarla completa.

**"RLS policy violation":** estás usando la anon key en vez de la service_role.
La anon respeta RLS; la service_role lo bypassa, que es lo que necesitamos
para hacer bulk insert.

**Se corta el upload a la mitad:** no hay problema — corré el script de nuevo.
Los puzzles ya subidos se hacen upsert (no duplican), y continúa desde donde
quedó.

**Demasiados/pocos puzzles:** editá en `import_puzzles.py` las constantes
`MIN_POPULARITY`, `MAX_RATING_DEVIATION`, `TOP_PER_BUCKET` y `GENERAL_POOL`
para ajustar el tamaño del set.

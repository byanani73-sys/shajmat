-- ══════════════════════════════════════════════════════════════════════════════
-- Pájaro Carpintero (Woodpecker Method) — schema v1
--
-- Ejecutar en Supabase Dashboard → SQL Editor. Idempotente (usa
-- CREATE ... IF NOT EXISTS y CREATE OR REPLACE).
-- ══════════════════════════════════════════════════════════════════════════════

-- ── Tabla: sets de puzzles ────────────────────────────────────────────────────
-- Un usuario puede tener varios sets activos en paralelo. Cada set tiene un
-- tamaño fijo, filtros congelados (rating + temas + aperturas) y avanza por
-- ciclos (1..total_cycles). El status permite abandonar un set sin borrarlo.
CREATE TABLE IF NOT EXISTS public.woodpecker_sets (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name              text        NOT NULL,
  size              integer     NOT NULL CHECK (size > 0 AND size <= 2000),
  filters           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  order_mode        text        NOT NULL DEFAULT 'fixed' CHECK (order_mode IN ('fixed', 'random')),
  time_target_pct   integer     NOT NULL DEFAULT 50 CHECK (time_target_pct BETWEEN 10 AND 100),
  total_cycles      integer     NOT NULL DEFAULT 7 CHECK (total_cycles BETWEEN 1 AND 20),
  current_cycle     integer     NOT NULL DEFAULT 1 CHECK (current_cycle >= 1),
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  next_session_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);
CREATE INDEX IF NOT EXISTS woodpecker_sets_user_status_idx
  ON public.woodpecker_sets(user_id, status, created_at DESC);


-- ── Tabla: puzzles del set (los N IDs fijos, orden inicial) ──────────────────
-- El orden inicial se congela acá. Si order_mode = 'random', el orden efectivo
-- de cada ciclo se calcula del lado cliente con un seed determinista
-- (set_id + cycle_number), así no tenemos que persistirlo por ciclo.
CREATE TABLE IF NOT EXISTS public.woodpecker_puzzles (
  set_id     uuid    NOT NULL REFERENCES public.woodpecker_sets(id) ON DELETE CASCADE,
  position   integer NOT NULL,
  puzzle_id  text    NOT NULL,
  PRIMARY KEY (set_id, position)
);
CREATE INDEX IF NOT EXISTS woodpecker_puzzles_puzzle_idx
  ON public.woodpecker_puzzles(puzzle_id);


-- ── Tabla: intentos (una fila por intento de puzzle) ─────────────────────────
-- correct + time_ms se agregan para calcular métricas por ciclo. is_retry se
-- marca cuando el intento fue en "Revisar errores de la última sesión" — esos
-- no cuentan para el tiempo/errores del ciclo (v1.1).
-- session_group_id agrupa intentos de una misma sentada — permite filtrar
-- "los errores de la última sesión".
CREATE TABLE IF NOT EXISTS public.woodpecker_attempts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id            uuid        NOT NULL REFERENCES public.woodpecker_sets(id) ON DELETE CASCADE,
  cycle_number      integer     NOT NULL,
  puzzle_id         text        NOT NULL,
  position          integer     NOT NULL,
  time_ms           integer     NOT NULL DEFAULT 0 CHECK (time_ms >= 0),
  correct           boolean     NOT NULL,
  is_retry          boolean     NOT NULL DEFAULT false,
  session_group_id  uuid,
  attempted_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS woodpecker_attempts_set_cycle_idx
  ON public.woodpecker_attempts(set_id, cycle_number, attempted_at);
CREATE INDEX IF NOT EXISTS woodpecker_attempts_session_idx
  ON public.woodpecker_attempts(session_group_id);


-- ══════════════════════════════════════════════════════════════════════════════
-- RLS: cada usuario ve y modifica sólo sus propios sets, puzzles y attempts.
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.woodpecker_sets     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.woodpecker_puzzles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.woodpecker_attempts ENABLE ROW LEVEL SECURITY;

-- Sets
DROP POLICY IF EXISTS "own sets" ON public.woodpecker_sets;
CREATE POLICY "own sets" ON public.woodpecker_sets
  FOR ALL
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Puzzles (a través del set)
DROP POLICY IF EXISTS "own set puzzles" ON public.woodpecker_puzzles;
CREATE POLICY "own set puzzles" ON public.woodpecker_puzzles
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.woodpecker_sets s
    WHERE s.id = woodpecker_puzzles.set_id AND s.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.woodpecker_sets s
    WHERE s.id = woodpecker_puzzles.set_id AND s.user_id = auth.uid()
  ));

-- Attempts (a través del set)
DROP POLICY IF EXISTS "own set attempts" ON public.woodpecker_attempts;
CREATE POLICY "own set attempts" ON public.woodpecker_attempts
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.woodpecker_sets s
    WHERE s.id = woodpecker_attempts.set_id AND s.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.woodpecker_sets s
    WHERE s.id = woodpecker_attempts.set_id AND s.user_id = auth.uid()
  ));


-- ══════════════════════════════════════════════════════════════════════════════
-- RPC: pick_puzzles_for_set
--
-- Reutiliza los mismos filtros de get_random_puzzle pero devuelve N puzzles
-- (id + rating + themes) en un solo call. Ordenados aleatoriamente, sin
-- repetidos entre sí. Si no hay suficientes puzzles que matcheen, devuelve
-- los que haya (el caller decide si acepta o pide al user que afloje filtros).
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.pick_puzzles_for_set(
  p_count           integer,
  p_min_rating      integer DEFAULT 400,
  p_max_rating      integer DEFAULT 3000,
  p_mate_themes     text[]  DEFAULT NULL,
  p_mate_patterns   text[]  DEFAULT NULL,
  p_tactics         text[]  DEFAULT NULL,
  p_phases          text[]  DEFAULT NULL,
  p_endgame_types   text[]  DEFAULT NULL,
  p_lengths         text[]  DEFAULT NULL,
  p_evaluations     text[]  DEFAULT NULL,
  p_openings_filter text[]  DEFAULT NULL
)
RETURNS TABLE (
  puzzle_id text,
  rating    integer,
  themes    text[]
)
LANGUAGE sql
STABLE
AS $$
  SELECT id, rating, themes
  FROM public.puzzles
  WHERE (p_mate_themes     IS NULL OR themes       && p_mate_themes)
    AND (p_mate_patterns   IS NULL OR themes       && p_mate_patterns)
    AND (p_tactics         IS NULL OR themes       && p_tactics)
    AND (p_phases          IS NULL OR themes       && p_phases)
    AND (p_endgame_types   IS NULL OR themes       && p_endgame_types)
    AND (p_lengths         IS NULL OR themes       && p_lengths)
    AND (p_evaluations     IS NULL OR themes       && p_evaluations)
    AND (p_openings_filter IS NULL OR opening_tags && p_openings_filter)
    AND rating BETWEEN p_min_rating AND p_max_rating
  ORDER BY random()
  LIMIT GREATEST(1, p_count);
$$;

-- Permitir que la RPC sea llamable por usuarios autenticados
GRANT EXECUTE ON FUNCTION public.pick_puzzles_for_set(
  integer, integer, integer,
  text[], text[], text[], text[], text[], text[], text[], text[]
) TO authenticated;

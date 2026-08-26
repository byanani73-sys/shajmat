-- ══════════════════════════════════════════════════════════════════════════════
-- Push notifications — schema para recordatorios de sesión del pájaro carpintero
--
-- Ejecutar en Supabase Dashboard → SQL Editor. Idempotente.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── Suscripciones web-push ────────────────────────────────────────────────
-- Cada dispositivo/navegador donde el usuario habilita push crea una fila.
-- Un mismo user_id puede tener varias filas (celular + laptop + tablet).
--
-- Los campos p256dh y auth vienen del PushSubscription del browser y son
-- necesarios para encriptar el payload al enviar el push.
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint     text        NOT NULL,          -- URL única de push service (FCM/APNs/etc)
  p256dh       text        NOT NULL,          -- Public key del cliente (base64url)
  auth         text        NOT NULL,          -- Auth secret del cliente (base64url)
  user_agent   text,                          -- Info del device (opcional, para debug)
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,                   -- Última vez que se le mandó push OK
  UNIQUE (user_id, endpoint)  -- Evita duplicados por device
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON public.push_subscriptions(user_id);

-- ── Timestamp del último push enviado por set ─────────────────────────────
-- Se agrega en woodpecker_sets para deduplicar: si ya mandamos el push del
-- recordatorio en las últimas 20h, no re-enviamos aunque el cron corra otra vez.
ALTER TABLE public.woodpecker_sets
  ADD COLUMN IF NOT EXISTS last_push_sent_at timestamptz;


-- ══════════════════════════════════════════════════════════════════════════════
-- RLS: cada usuario ve/modifica sólo sus subscriptions.
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own subscriptions" ON public.push_subscriptions;
CREATE POLICY "own subscriptions" ON public.push_subscriptions
  FOR ALL
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

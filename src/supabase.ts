import { createClient } from '@supabase/supabase-js'

// Estas credenciales son seguras para exponer — respetan RLS.
// La publishable key (sb_publishable_...) solo permite leer puzzles.
const SUPABASE_URL = 'https://vqtznfadpvqfpnkiwgak.supabase.co'
const SUPABASE_KEY = 'sb_publishable_YBLiZEcGWeY-aI-58vOUKA_aJ64zQPj'

// Sesión persistente entre cierres de browser:
// - persistSession: true       → guarda la sesión en localStorage
// - autoRefreshToken: true     → refresca el JWT antes de que expire (cada hora)
// - detectSessionInUrl: true   → al volver de OAuth, lee el #access_token de la URL
// - storageKey explícito       → evita colisiones entre clientes Supabase
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession:     true,
    autoRefreshToken:   true,
    detectSessionInUrl: true,
    storage:            typeof window !== 'undefined' ? window.localStorage : undefined,
    storageKey:         'shajmat-auth',
  },
})

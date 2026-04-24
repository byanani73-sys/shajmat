import { createClient } from '@supabase/supabase-js'

// Estas credenciales son seguras para exponer — respetan RLS.
// La publishable key (sb_publishable_...) solo permite leer puzzles.
const SUPABASE_URL = 'https://vqtznfadpvqfpnkiwgak.supabase.co'
const SUPABASE_KEY = 'sb_publishable_YBLiZEcGWeY-aI-58vOUKA_aJ64zQPj'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

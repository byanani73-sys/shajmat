import { supabase } from './supabase'

// Guarda feedback del usuario en la tabla `feedback` de Supabase.
// La tabla tiene RLS habilitada con una policy que permite INSERT a anónimos.
export async function saveFeedback(message: string, userId?: string): Promise<boolean> {
  const trimmed = message.trim()
  if (!trimmed) return false
  const { error } = await supabase.from('feedback').insert({
    message: trimmed,
    user_id: userId ?? null,
  })
  if (error) { console.error('Error guardando feedback:', error); return false }
  return true
}

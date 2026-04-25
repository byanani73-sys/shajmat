import { supabase } from './supabase'
import type { User } from '@supabase/supabase-js'

export const LICHESS = 'https://lichess.org'

// ── Tipos ──────────────────────────────────────────────────────────────────
export interface AuthUser {
  id:          string
  email?:      string
  provider:    'google' | 'email' | 'guest'
  username?:   string
  lichessId?:  string
  lichessElo?: number
}

// ── Email + contraseña ─────────────────────────────────────────────────────
export async function signUpWithEmail(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signUp({ email, password })
  if (error) throw error
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
}

// ── Google OAuth ───────────────────────────────────────────────────────────
export async function signInWithGoogle(): Promise<void> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  })
  if (error) throw error
}

// ── Sign out ───────────────────────────────────────────────────────────────
export async function signOut(): Promise<void> {
  await supabase.auth.signOut()
}

// ── Auth state ────────────────────────────────────────────────────────────
// onAuthStateChange dispara INITIAL_SESSION al subscribirse, pero ese evento
// puede llegar con null antes de que detectSessionInUrl termine de parsear el
// hash de OAuth. Para evitar pantallazos a "login" usar getCurrentUser() al
// arrancar y filtrar INITIAL_SESSION en el listener.
export function onAuthStateChange(cb: (user: User | null, event: string) => void) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    cb(session?.user ?? null, event)
  })
  return () => subscription.unsubscribe()
}

export async function getCurrentUser(): Promise<User | null> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.user ?? null
}

// ── Construir AuthUser desde Supabase User ─────────────────────────────────
export function buildAuthUser(user: User): AuthUser {
  const provider = (user.app_metadata?.provider ?? 'email') as string
  const meta     = user.user_metadata ?? {}
  return {
    id:       user.id,
    email:    user.email,
    provider: provider === 'google' ? 'google' : 'email',
    username: meta.full_name ?? meta.name ?? user.email?.split('@')[0],
  }
}

// ── Perfil ────────────────────────────────────────────────────────────────
export async function getProfile(userId: string) {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()
  return data
}

export async function updateProfile(userId: string, updates: {
  lichess_id?: string
  lichess_elo?: number
  username?: string
}) {
  const { error } = await supabase
    .from('profiles')
    .upsert({ id: userId, ...updates })
  if (error) throw error
}

// ═══ Lichess PKCE OAuth ════════════════════════════════════════════════════
// Lichess no requiere registrar app ni client_secret.
// OAuth 2.0 con PKCE — flujo 100% client-side.

const LICHESS_CLIENT_ID = 'shajmat'
const PKCE_STORAGE_KEY  = 'shajmat_pkce_verifier'

function getLichessRedirect(): string {
  return `${window.location.origin}/lichess-callback`
}

function generateRandomString(length = 64): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  return Array.from(array, b => chars[b % chars.length]).join('')
}

async function sha256Base64Url(plain: string): Promise<string> {
  const data   = new TextEncoder().encode(plain)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function startLichessOAuth(): Promise<void> {
  const verifier  = generateRandomString(64)
  const challenge = await sha256Base64Url(verifier)
  sessionStorage.setItem(PKCE_STORAGE_KEY, verifier)

  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             LICHESS_CLIENT_ID,
    redirect_uri:          getLichessRedirect(),
    scope:                 'email:read',
    code_challenge_method: 'S256',
    code_challenge:        challenge,
    state:                 generateRandomString(16),
  })
  window.location.href = `${LICHESS}/oauth?${params}`
}

export async function handleLichessCallback(code: string): Promise<string> {
  const verifier = sessionStorage.getItem(PKCE_STORAGE_KEY)
  if (!verifier) throw new Error('PKCE verifier no encontrado. Intentá de nuevo.')
  sessionStorage.removeItem(PKCE_STORAGE_KEY)

  const res = await fetch(`${LICHESS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     LICHESS_CLIENT_ID,
      redirect_uri:  getLichessRedirect(),
      code,
      code_verifier: verifier,
    }),
  })
  if (!res.ok) throw new Error(`Lichess error: ${await res.text()}`)
  const data = await res.json()
  return data.access_token
}

export async function fetchLichessAccount(token: string): Promise<{
  id: string; username: string; puzzleElo?: number
}> {
  const res = await fetch(`${LICHESS}/api/account`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error('No se pudo obtener la cuenta de Lichess')
  const data = await res.json()
  return { id: data.id, username: data.username, puzzleElo: data.perfs?.puzzle?.rating }
}

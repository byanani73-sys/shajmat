// Token personal de Lichess — sin OAuth, sin backend, sin configuración
// El usuario lo genera en: https://lichess.org/account/security → "New token"

const TOKEN_KEY = 'ps_token'
const USER_KEY  = 'ps_user'

export const getToken  = (): string | null => localStorage.getItem(TOKEN_KEY)
export const saveToken = (t: string)       => localStorage.setItem(TOKEN_KEY, t)
export const getUser   = ()                => { const u = localStorage.getItem(USER_KEY); return u ? JSON.parse(u) : null }
export const saveUser  = (u: object)       => localStorage.setItem(USER_KEY, JSON.stringify(u))
export const LICHESS = 'https://lichess.org'
export const clearAuth = ()                => { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY) }

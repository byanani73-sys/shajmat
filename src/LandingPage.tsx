import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { signInWithGoogle, getCurrentUser } from './auth'
import './LandingPage.css'

// Landing page de Shajmat. La estructura sigue 1:1 a shajmat-landing.html
// — mismo HTML, mismas clases, mismos textos. Lo único que cambia es:
//   • los onClick en vanilla JS se reemplazan por handlers de React
//   • si el usuario ya está logueado al aterrizar acá, lo mandamos a /entrenar
//   • el modal usa estado en lugar de toggle de clase CSS
//
// El prompt post-sesión vive dentro de la app, no en la landing.

export function LandingPage() {
  const navigate = useNavigate()
  const [modalOpen,  setModalOpen]  = useState(false)
  const [signingIn,  setSigningIn]  = useState(false)
  const [authError,  setAuthError]  = useState<string | null>(null)

  // Si el usuario ya tiene sesión activa, no tiene sentido mostrarle la
  // landing — lo derivamos directo a la app. Hacemos el chequeo una vez
  // al montar; durante el chequeo se muestra la landing como fallback
  // (la transición es prácticamente instantánea).
  useEffect(() => {
    let cancelled = false
    getCurrentUser().then(user => {
      if (cancelled || !user) return
      navigate('/entrenar', { replace: true })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [navigate])

  const handleGoogle = async () => {
    setSigningIn(true)
    setAuthError(null)
    try {
      // signInWithGoogle redirige a Google y luego a /entrenar — la promesa
      // resuelve cuando se inicia el redirect, pero la página ya se está
      // yendo. No hace falta limpiar setSigningIn.
      await signInWithGoogle()
    } catch (e) {
      setAuthError((e as Error).message)
      setSigningIn(false)
    }
  }

  const handleGuest = () => {
    // Marca de "intención de entrar como invitado" para que App.tsx no muestre
    // el login screen al aterrizar. La marca dura solo lo que la pestaña esté
    // abierta — si el usuario cierra y vuelve, la landing aparece de nuevo.
    sessionStorage.setItem('shajmat_guest_intent', '1')
    navigate('/entrenar')
  }

  const openModal  = () => setModalOpen(true)
  const closeModal = () => setModalOpen(false)

  return (
    <div className="landing">
      {/* NAV */}
      <nav>
        <div className="logo-wrap">
          <ShinSvg size={28} />
          <span className="wordmark">SHAJMAT</span>
        </div>
        <div className="nav-ctas">
          <button className="btn-solid btn-sm" onClick={openModal}>Empezar a entrenar</button>
          <button className="btn-outline btn-sm" onClick={openModal}>Ya tengo cuenta</button>
        </div>
      </nav>

      {/* HERO */}
      <section className="hero">
        <p className="eyebrow">Entrenamiento Táctico</p>
        <h1>Las herramientas de entrenamiento táctico que ya conocés, <em>mejoradas</em></h1>
        <p className="hook">
          Si podés resolver 30 ejercicios del Streak sin equivocarte, <strong>no te estás desafiando</strong>. Y si no te desafiás, no mejorás.
        </p>
        <div className="cta-group">
          <button className="btn-solid btn-lg" onClick={openModal}>Empezar a entrenar</button>
          <button className="btn-outline btn-lg" onClick={openModal}>Ya tengo cuenta</button>
        </div>
      </section>

      <hr />

      {/* PROBLEMA */}
      <section className="problem">
        <p className="section-label">El problema</p>
        <p className="problem-quote">
          Puzzle Storm y Streak son geniales. Pero siempre arrancan fácil, y no te dejan elegir qué tipo de táctica entrenar.
        </p>
        <p className="problem-sub">
          Si pasás entre 1 y 2 minutos del Storm resolviendo ejercicios demasiado fáciles, estás desperdiciando entre el 30% y el 60% de tu entrenamiento.
        </p>
      </section>

      <hr />

      {/* FEATURES */}
      <section className="features">
        <p className="section-label">Qué cambia</p>
        <div className="feat-grid">
          <Feature title="Nivel fijo desde el principio"
            desc="Sin regalos. Elegís tu rango de ELO y cada ejercicio está dentro de ese rango." />
          <Feature title="Filtros combinados"
            desc="Tema + apertura + nivel al mismo tiempo. Entrenás exactamente lo que querés trabajar." />
          <Feature title="Calibrado a tu ELO de Lichess"
            desc="Conectás tu cuenta y los ejercicios se adaptan a tu nivel real." />
          <Feature title="Storm, Streak y Práctica"
            desc="Los modos que ya conocés, con los filtros que siempre quisiste. Más modos en camino." />
        </div>
      </section>

      <hr />

      {/* BOTTOM CTA */}
      <section className="bottom">
        <p className="bottom-title">Empezá a entrenar en serio</p>
        <p className="bottom-sub">100% gratis. Conectá tu cuenta de Lichess para calibrar tu nivel.</p>
        <div className="cta-group">
          <button className="btn-solid btn-lg" onClick={openModal}>Empezar a entrenar</button>
          <button className="btn-outline btn-lg" onClick={openModal}>Ya tengo cuenta</button>
        </div>
        <span className="shin">ש</span>
      </section>

      {/* MODAL INICIO */}
      {modalOpen && (
        <div className="overlay" onClick={e => { if (e.target === e.currentTarget) closeModal() }}>
          <div className="modal">
            <ShinSvg size={36} extraClass="modal-mark" />
            <p className="modal-title">SHAJMAT</p>
            <p className="modal-sub">
              Entrá con Google para guardar tu progreso y ver métricas de tu mejora. O empezá a jugar directo.
            </p>
            <div className="modal-actions">
              <button className="btn-google" onClick={handleGoogle} disabled={signingIn}>
                <GoogleSvg />
                {signingIn ? 'Conectando…' : 'Entrar con Google'}
              </button>
              <button className="btn-guest" onClick={handleGuest}>Continuar sin cuenta →</button>
            </div>
            {authError
              ? <p className="modal-note" style={{ color: '#e05252' }}>Error: {authError}</p>
              : <p className="modal-note">El login toma menos de 10 segundos</p>}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Subcomponentes ─────────────────────────────────────────────────────────

function Feature({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="feat-item">
      <div className="feat-dot" />
      <p className="feat-title">{title}</p>
      <p className="feat-desc">{desc}</p>
    </div>
  )
}

function ShinSvg({ size, extraClass }: { size: number; extraClass?: string }) {
  return (
    <svg viewBox="0 0 72 90" width={size} height={size * 1.25} fill="none"
      xmlns="http://www.w3.org/2000/svg" className={extraClass}>
      <rect x="10" y="77" width="52" height="4.5" rx="2.25" fill="#c17f2a" />
      <path d="M22 77 C22 56, 14 38, 9 26 Q7 18 12 16" stroke="#c17f2a" strokeWidth="5" strokeLinecap="round" />
      <line x1="36" y1="77" x2="36" y2="8" stroke="#c17f2a" strokeWidth="5" strokeLinecap="round" />
      <path d="M50 77 C50 56, 58 38, 63 26 Q65 18 60 16" stroke="#c17f2a" strokeWidth="5" strokeLinecap="round" />
    </svg>
  )
}

function GoogleSvg() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  )
}

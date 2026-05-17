import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { LandingPage } from './LandingPage.tsx'

// Rutas:
//  /          → LandingPage (la entrada pública del sitio)
//  /entrenar  → la app de entrenamiento (todo el flujo de App.tsx)
//
// Cualquier otra ruta cae a la landing para evitar 404s extraños. El
// vercel.json ya tiene un rewrite que manda todo a index.html, así que
// el routing client-side se hace cargo.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/"          element={<LandingPage />} />
        <Route path="/entrenar"  element={<App />} />
        <Route path="*"          element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)

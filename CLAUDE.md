# Shajmat

App web de entrenamiento de ajedrez, con foco actual en **entrenamiento táctico**. Hosteada de forma abierta y gratuita, ya con usuarios reales.

## Producto

Tres modos de entrenamiento:

- **Storm** — resolver la mayor cantidad posible en tiempo limitado.
- **Strike** — racha; un error termina la sesión.
- **Práctica libre** — sin presión de tiempo ni pérdida por error.

**Diferencial vs. Lichess** (protegerlo al proponer cambios):

- Lichess permite filtrar por nivel **o** por temas tácticos, no ambos a la vez. Su granularidad de nivel es gruesa.
- En Storm/Strike de Lichess el nivel arranca muy fácil y va subiendo con aciertos; si perdés, volvés a empezar de cero. El nivel promedio de la sesión termina siendo bajo.
- Shajmat permite entrenar **desde el arranque** con ejercicios acordes al nivel del usuario, y **combinar** nivel fino + filtro por temas tácticos (mates, patrones, tácticas, fases, finales, aperturas).

**Roadmap:** planes de sumar modalidades más allá de lo táctico (aún sin definir).

## Stack

- **Frontend:** Vite + React 19 + TypeScript, Tailwind 3.4 + shadcn/ui (Radix), React Router 7
- **Tablero:** `chess.js` + `chessground`
- **Backend:** Supabase (auth, sesiones, RPC, RLS)
- **Auth providers:** Google OAuth, email/password, y OAuth con Lichess (para leer el rating de puzzle del usuario)
- **PWA:** `vite-plugin-pwa`, con soporte offline (IndexedDB local + outbox de sesiones)
- **Deploy:** Vercel como SPA — [vercel.json](vercel.json) reescribe todo a `/index.html` y setea headers de seguridad estrictos (HSTS, X-Frame-Options, etc.)

## Comandos

```bash
pnpm dev      # vite dev server
pnpm build    # tsc -b && vite build
pnpm lint     # eslint .
pnpm preview  # servir el build
```

## Rutas

- `/` — landing pública ([LandingPage.tsx](src/LandingPage.tsx))
- `/entrenar` — la app propiamente dicha ([App.tsx](src/App.tsx))

Google OAuth redirige a `/entrenar` para que la landing no procese el hash de sesión.

## Arquitectura del código

Todo el código de app vive en `src/` (no hay `src/pages/` ni monorepo). Archivos clave:

- [App.tsx](src/App.tsx) — máquina de estados de la app (~3k líneas). Estados: `init | login | config | preparing | storm | results | review | dashboard`. Contiene la lógica de flujo de sesión, UI, dashboard, y validación de jugadas.
- [ChessBoard.tsx](src/ChessBoard.tsx) — wrapper de chessground.
- [lichess.ts](src/lichess.ts) — `PuzzleQueue` que sirve puzzles filtrados desde la tabla `puzzles` de Supabase (o desde el offline DB si no hay conexión). Los puzzles originales vienen del dump público de Lichess. Tipos: `Puzzle`, `PuzzleFilters` (mateThemes, matePatterns, tactics, phases, endgameTypes, lengths, evaluations, openingTags, minRating, maxRating).
- [themes.ts](src/themes.ts) — catálogo de temas tácticos y aperturas, traducciones ES, y `buildFiltersFromSelection`.
- [sessions.ts](src/sessions.ts) — CRUD de sesiones + queries del dashboard (summary, activity, streak, weekly best, theme stats via RPC, all-time bests).
- [auth.ts](src/auth.ts) — wrappers de Supabase auth + Lichess OAuth (PKCE) + `profiles` (username, elo, formato).
- [offlineDb.ts](src/offlineDb.ts) / [offlineOutbox.ts](src/offlineOutbox.ts) / [offlineSync.ts](src/offlineSync.ts) — IndexedDB con puzzles pre-cargados, outbox de sesiones pendientes, y sync al volver online.
- [sounds.ts](src/sounds.ts) — sonidos de Lichess (MIT) servidos desde `public/sounds/`. Reemplazaron la Web Audio API en un commit reciente.
- [feedback.ts](src/feedback.ts) — guardar feedback de usuarios.
- [supabase.ts](src/supabase.ts) — cliente. La `publishable key` está hardcodeada y **es segura para exponer** (RLS filtra todo lo sensible; sólo permite leer puzzles).

## Supabase

**Proyecto:** `vqtznfadpvqfpnkiwgak.supabase.co`

Tablas usadas por la app (según el código):

- `puzzles` — dump de puzzles de Lichess. Columnas: `id, fen, solution, rating, rating_deviation, popularity, themes[], opening_tags[]`. Lectura pública.
- `sessions` — una fila por sesión de entrenamiento. Columnas: `id (uuid), user_id, mode ('storm'|'streak'|'practice'), minutes, themes[], opening_tags[], min_rating, max_rating, score_ok, score_err, puzzles_seen[], started_at, ended_at`. Se hace `upsert` con `onConflict: 'id'` para que el retry desde outbox sea idempotente.
- `session_errors` — puzzles fallados de cada sesión (`session_id, puzzle_id`).
- `profiles` — perfil del usuario (username, lichess link, elo).
- Feedback: ver [feedback.ts](src/feedback.ts).

**RPC:** `dashboard_theme_stats(p_user_id, p_since)` — agrega errores por tema para el dashboard.

**RLS:** activo. La clave publishable solo permite leer `puzzles`; el resto requiere sesión autenticada.

## Convenciones y detalles a tener en cuenta

- **Validación de mate en 1 con múltiples soluciones:** [App.tsx:55-77](src/App.tsx:55) acepta cualquier jugada que dé mate cuando la esperada también da mate. Es la regla de Lichess — respetarla si se toca la validación.
- **Comentarios en español** en el código (docstrings, secciones).
- **Idempotencia:** el guardado de sesión usa `id` generado en cliente + `upsert`. Cualquier retry (online u outbox) debe reusar el mismo id.
- **Offline first:** las sesiones se pueden completar sin internet. Al reconectar, `offlineOutbox` las flushea.
- **Sonidos:** usar los archivos de `public/sounds/` (Lichess, MIT). No volver a Web Audio API — hubo un commit para reemplazarla.
- **Streak / timer:** el timer se pausa al cambiar de ventana y la práctica no termina automáticamente (fix reciente — no revertirlo).
- **La landing y la app son rutas distintas.** No mezclar componentes: la landing es marketing, la app es funcional.

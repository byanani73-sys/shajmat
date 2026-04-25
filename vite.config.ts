import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name:             "Shajmat",
        short_name:       "Shajmat",
        description:      "Entrenamiento táctico de ajedrez",
        start_url:        "/",
        display:          "standalone",
        orientation:      "portrait",
        background_color: "#0e0d0b",
        theme_color:      "#c17f2a",
        lang:             "es",
        icons: [
          { src: "/icon-192.png",          sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png",          sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // App shell: HTML, JS, CSS, fuentes locales — CacheFirst (precache)
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
        // El .wasm de Stockfish pesa 7MB, lejos del default de workbox (2MB).
        // No lo precacheamos; el runtime caching de abajo lo guarda on-demand
        // cuando el usuario activa el toggle de análisis por primera vez.
        globIgnores: ["**/stockfish/*.wasm"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          // Stockfish WASM + worker JS: CacheFirst, expiración larga.
          // Una vez descargado queda disponible offline en próximas sesiones.
          {
            urlPattern: /\/stockfish\/.*\.(?:js|wasm)$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "stockfish-engine",
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
              rangeRequests: true,
            },
          },
          // Supabase API: NetworkFirst (intentar red, fallback caché si offline)
          {
            urlPattern: /^https:\/\/[a-z0-9]+\.supabase\.co\/.*/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "supabase-api",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 }, // 7 días
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Google Fonts: CacheFirst con expiración larga
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-stylesheets",
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 }, // 1 año
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-files",
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom"],
  },
});

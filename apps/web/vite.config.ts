import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_URL = process.env.HUDDLE_API_URL ?? 'http://localhost:4000';
const COLLAB_URL = process.env.HUDDLE_COLLAB_URL ?? 'ws://localhost:1234';

// In dev the API and collab servers are proxied so the browser sees a single
// origin: the refresh cookie stays SameSite=Strict and no CORS is needed. In
// production the same is achieved with Vercel rewrites (see vercel.json).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_URL, changeOrigin: true },
      '/collab': { target: COLLAB_URL, ws: true, rewrite: (p) => p.replace(/^\/collab/, '') },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: API_URL, changeOrigin: true },
      '/collab': { target: COLLAB_URL, ws: true, rewrite: (p) => p.replace(/^\/collab/, '') },
    },
  },
  build: {
    sourcemap: true,
  },
});

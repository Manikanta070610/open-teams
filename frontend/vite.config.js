import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two services, one codebase:
// - public app: index.html -> /src/main.jsx (no admin code), dev :5173,
//   proxies /api to the public backend (:4000).
// - admin back-office: admin.html -> /src/admin-main.jsx, dev :5174,
//   proxies /api to the admin backend (:4001).
// VITE_APP_TARGET=public|admin|all (default all).
// - public: only index.html -> dist/ (employee app, no admin.html shipped).
// - admin: only admin.html -> dist-admin/ (back-office, no index.html shipped).
// - all: both (local verification).
// Separate outDirs guarantee the public static host never serves admin.html
// (and vice versa) — guessing the other entry's URL 404s in production.
const appTarget = process.env.VITE_APP_TARGET || 'all';
const input =
  appTarget === 'public'
    ? { main: 'index.html' }
    : appTarget === 'admin'
      ? { admin: 'admin.html' }
      : { main: 'index.html', admin: 'admin.html' };

// VITE_BACKEND_TARGET overrides the proxy target when running the admin
// dev server (see package.json dev:admin script).
const backendTarget = process.env.VITE_BACKEND_TARGET || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': backendTarget,
    },
  },
  preview: { port: 4173 },
  build: {
    outDir: appTarget === 'admin' ? 'dist-admin' : 'dist',
    rollupOptions: {
      input,
    },
  },
});

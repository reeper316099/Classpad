import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = process.env.VITE_API_URL ?? 'http://127.0.0.1:4783';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: { '/api': { target: API, changeOrigin: true } },
  },
  // never inline assets as data: URLs: the app's CSP (font-src 'self') would block inlined fonts such as KaTeX's
  build: { target: 'es2022', sourcemap: true, assetsInlineLimit: 0 },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});

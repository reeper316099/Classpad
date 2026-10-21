import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = process.env.VITE_API_URL ?? 'http://127.0.0.1:4783';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: { '/api': { target: API, changeOrigin: false } },
  },
  build: { target: 'es2022', sourcemap: true },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});

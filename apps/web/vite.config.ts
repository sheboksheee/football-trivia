import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.FT_API ?? 'http://localhost:8787';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': api,
      '/healthz': api,
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
  build: { target: 'es2022', sourcemap: true },
});

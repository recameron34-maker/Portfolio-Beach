import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.PB_API_URL ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/health': { target: api, changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/health': { target: api, changeOrigin: true },
    },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 1500 },
});

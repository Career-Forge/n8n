import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-only proxy so `npm run dev` (vite on its own port) can call the
// FastAPI sidecar without CORS -- production serves both from one origin
// (FastAPI mounts the built dist/ directly, see ../Dockerfile).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:5681',
    },
  },
  build: {
    outDir: 'dist',
  },
});

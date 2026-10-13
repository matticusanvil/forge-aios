import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev` proxies the live server, so the UI can be worked on from any machine.
const backend = process.env.FORGE_BACKEND ?? 'http://127.0.0.1:3200';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/ws': { target: backend.replace(/^http/, 'ws'), ws: true }, '/api': backend } },
});

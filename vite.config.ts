import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  base: './',
  plugins: [react()],
  preview: {
    host: '127.0.0.1',
    port: 4319,
    strictPort: true,
    allowedHosts: process.env.AGENT_OFFICE_WEB_ORIGIN
      ? [new URL(process.env.AGENT_OFFICE_WEB_ORIGIN).hostname]
      : [],
    proxy: { '/api': { target: 'http://127.0.0.1:4318', changeOrigin: true } },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4318' },
    watch: { ignored: ['**/.research/**', '**/.local/**', '**/release/**', '**/docs/images/**'] },
  },
  build: { chunkSizeWarningLimit: 700 },
});

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { DEFAULT_UI_PORT, devPorts } from './server/dev-ports.ts';
const ports = devPorts();
const api = `http://127.0.0.1:${ports.api}`;
/** index.html's CSP lets the dev page reach Vite's HMR socket: on another port, that port. */
const hmrSocket: Plugin = {
  name: 'agent-office-hmr-socket',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html.replace(`ws://127.0.0.1:${DEFAULT_UI_PORT}`, `ws://127.0.0.1:${ports.ui}`),
};
export default defineConfig({
  base: './',
  plugins: [react(), hmrSocket],
  preview: {
    host: '127.0.0.1',
    port: 4319,
    strictPort: true,
    allowedHosts: process.env.AGENT_OFFICE_WEB_ORIGIN
      ? [new URL(process.env.AGENT_OFFICE_WEB_ORIGIN).hostname]
      : [],
    proxy: { '/api': { target: api, changeOrigin: true } },
  },
  server: {
    port: ports.ui,
    strictPort: true,
    proxy: { '/api': api },
    watch: { ignored: ['**/.research/**', '**/.local/**', '**/release/**', '**/docs/images/**'] },
  },
  build: {
    chunkSizeWarningLimit: 700,
    rolldownOptions: { input: { main: 'index.html', mobile: 'mobile.html' } },
  },
});

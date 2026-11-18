import http from 'node:http';
import { OfficeService } from './service.js';
import { m } from '../src/shared/i18n/index.js';
import { devPorts } from './dev-ports.js';
const ports = devPorts();
const service = new OfficeService();
service.start();
const allowed = new Set([
  `http://127.0.0.1:${ports.ui}`,
  `http://localhost:${ports.ui}`,
  `http://127.0.0.1:${ports.api}`,
  'http://127.0.0.1:4319',
  'http://localhost:4319',
]);
/** Calls only the desktop's main process makes (they reach the files outputs name). */
const DESKTOP_ONLY = new Set(['outputTarget', 'outputPreview']);
// An explicit private preview origin, e.g. Tailscale Serve. No wildcard origins.
const webOrigin = process.env.AGENT_OFFICE_WEB_ORIGIN;
if (webOrigin) allowed.add(new URL(webOrigin).origin);
const hosts = new Set([`127.0.0.1:${ports.api}`, `127.0.0.1:${ports.ui}`, `localhost:${ports.ui}`]);
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // The Vite dev proxy keeps the UI's Host; the preview proxy (and direct calls) use the collector's.
  if (!hosts.has(req.headers.host ?? '')) {
    res.writeHead(403);
    res.end('{}');
    return;
  }
  if (
    req.headers['x-agent-office'] !== '1' ||
    (req.headers.origin && !allowed.has(req.headers.origin))
  ) {
    res.writeHead(403);
    res.end('{}');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/api/rpc') {
    res.writeHead(404);
    res.end('{}');
    return;
  }
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 30000) throw new Error(m().server.rpc.tooLarge);
    }
    const { method, args } = JSON.parse(body);
    // The web preview lists outputs (#350) but never reads a recorded file or its real path.
    if (DESKTOP_ONLY.has(method)) throw new Error(m().server.rpc.unsupported);
    const result = await service.call(method, args);
    res.end(JSON.stringify({ result }));
  } catch (e) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : m().server.rpc.failed }));
  }
});
server.listen(ports.api, '127.0.0.1', () =>
  console.log(`Agent Office collector · http://127.0.0.1:${ports.api}`),
);
// Finish a pass in flight and write what the hot path staged before exiting. A second signal
// (or a shutdown stuck past 5 s) exits right away.
let exiting = false;
const exit = () => {
  if (exiting) process.exit(130);
  exiting = true;
  server.close();
  setTimeout(() => process.exit(1), 5000).unref();
  void service.shutdown().finally(() => process.exit(0));
};
process.on('SIGTERM', exit);
process.on('SIGINT', exit);

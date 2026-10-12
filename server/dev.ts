import http from 'node:http';
import { OfficeService } from './service.js';
import { m } from '../src/shared/i18n/index.js';
const service = new OfficeService();
service.start();
const allowed = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4318',
  'http://127.0.0.1:4319',
  'http://localhost:4319',
]);
// An explicit private preview origin, e.g. Tailscale Serve. No wildcard origins.
const webOrigin = process.env.AGENT_OFFICE_WEB_ORIGIN;
if (webOrigin) allowed.add(new URL(webOrigin).origin);
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (
    req.headers.host !== '127.0.0.1:4318' &&
    req.headers.host !== '127.0.0.1:5173' &&
    req.headers.host !== 'localhost:5173'
  ) {
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
    const result = await service.call(method, args);
    res.end(JSON.stringify({ result }));
  } catch (e) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : m().server.rpc.failed }));
  }
});
server.listen(4318, '127.0.0.1', () =>
  console.log('Agent Office collector · http://127.0.0.1:4318'),
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

import { PeerCommands } from './commands.js';
import type { PeerSender } from './sender.js';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { OfficeStore } from '../store.js';
import {
  exportConfigSchema,
  exportSession,
  wireId,
  idSchema,
  MAX_BYTES,
  type WireSnapshot,
} from './protocol.js';

/** Separate API. Never constructs OfficeService or opens the source database for writing. */
export async function startExportServer(dataDir: string, configDir: string, sender?: PeerSender) {
  const readConfig = () =>
    exportConfigSchema.parse(JSON.parse(readFileSync(path.join(configDir, 'export.json'), 'utf8')));
  const initial = readConfig();
  const store = new OfficeStore(dataDir, true);
  const commands = new PeerCommands(configDir, store, readConfig, sender);
  let epoch = randomUUID(),
    version = 0,
    signature = '',
    policy = '';
  const server = https.createServer(
    {
      key: readFileSync(path.join(configDir, 'server-key.pem')),
      cert: readFileSync(path.join(configDir, 'server-cert.pem')),
      minVersion: 'TLSv1.2',
      maxHeaderSize: 8192,
    },
    async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const send = (status: number, body: unknown) => {
        const json = JSON.stringify(body);
        if (Buffer.byteLength(json) > MAX_BYTES) {
          res.writeHead(413);
          res.end('{"error":"export-too-large"}');
        } else {
          res.writeHead(status);
          res.end(json);
        }
      };
      try {
        const route = new URL(req.url ?? '/', 'https://office.invalid').pathname;
        if (route.startsWith('/office/v1/commands/')) {
          await commands.handle(req, res, route);
          return;
        }
        // Reread to apply revocation and scope narrowing even to existing connections.
        const config = readConfig();
        const expected = Buffer.from(`Bearer ${config.token}`);
        const supplied = Buffer.from(req.headers.authorization ?? '');
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          send(401, { error: 'unauthorized' });
          return;
        }
        if (
          !config.enabled ||
          req.headers.origin ||
          req.method !== 'GET' ||
          (req.url?.length ?? 0) > 2048
        ) {
          send(403, { error: 'read-only-peer-api' });
          return;
        }
        const url = new URL(req.url!, 'https://office.invalid');
        if (!['/office/v1/snapshot', '/office/v1/detail'].includes(url.pathname)) {
          send(404, { error: 'not-found' });
          return;
        }
        const scope = wireId(JSON.stringify(config));
        if (scope !== policy) {
          policy = scope;
          epoch = randomUUID();
          signature = '';
          version = 0;
        }
        // Consistent read transaction, including the visibility policy and detail.
        store.db.exec('BEGIN');
        try {
          const prefs = store.preferences();
          const sessions = store
            .list()
            .filter(
              (s) =>
                !s.builtin &&
                (config.projects.includes('*') || config.projects.includes(s.project)),
            );
          if (sessions.length > 900) {
            send(413, { error: 'too-many-sessions' });
            return;
          }
          if (url.pathname.endsWith('/detail')) {
            if (!config.conversation) {
              send(403, { error: 'conversation-disabled' });
              return;
            }
            const parsed = idSchema.safeParse(url.searchParams.get('id'));
            const s = parsed.success ? sessions.find((x) => wireId(x.id) === parsed.data) : null;
            if (!s) {
              send(404, { error: 'not-found' });
              return;
            }
            const detail = store.detail(s.id, { limit: 180 });
            send(200, {
              officeId: config.officeId,
              session: exportSession(
                { ...detail, partial: detail.partial || !!detail.olderEvents },
                sessions,
                true,
              ),
            });
            return;
          }
          const exported = sessions.map((s) => exportSession(s, sessions));
          const next = wireId(JSON.stringify([exported, prefs.paused]));
          if (next !== signature) {
            signature = next;
            version++;
          }
          const common = {
            officeId: config.officeId,
            epoch,
            version,
            sampledAt: Date.now(),
            paused: prefs.paused,
            conversation: config.conversation,
          };
          if (
            url.searchParams.get('epoch') === epoch &&
            url.searchParams.get('version') === String(version)
          ) {
            send(200, { unchanged: true, ...common });
          } else {
            const snapshot: WireSnapshot = { protocol: 1, ...common, sessions: exported };
            send(200, snapshot);
          }
        } finally {
          store.db.exec('COMMIT');
        }
      } catch {
        // No schema details, source paths or session contents in errors/logs.
        send(503, { error: 'export-unavailable' });
      }
    },
  );
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 8;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(initial.port, initial.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (e) {
    store.close();
    throw e;
  }
  return {
    server,
    close: async () => {
      await commands.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

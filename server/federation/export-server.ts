import { DetailCache } from './detail-cache.js';
import { SnapshotVersions } from './snapshot-delta.js';
import { remoteEventWindow } from '../../src/shared/remote-conversation.js';
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
  type WireSession,
} from './protocol.js';

/** Separate API. Never constructs OfficeService or opens the source database for writing. */
export async function startExportServer(dataDir: string, configDir: string, sender?: PeerSender) {
  const readConfig = () =>
    exportConfigSchema.parse(JSON.parse(readFileSync(path.join(configDir, 'export.json'), 'utf8')));
  const initial = readConfig();
  const store = new OfficeStore(dataDir, true);
  const commands = new PeerCommands(configDir, store, readConfig, sender);
  let epoch = randomUUID(),
    policy = '';
  const versions = new SnapshotVersions();
  // One wire-only view. Never retain full stored conversations in a source-side list cache.
  const views = new DetailCache<{
    sessions: WireSession[];
    ids: Record<string, string>;
    paused: boolean;
    signature: string;
  }>(Date.now, MAX_BYTES, 1, 3000);
  const expiry = setInterval(() => views.prune(), 3000);
  expiry.unref();
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
          versions.clear();
          views.clear();
        }
        // Consistent read transaction, including the visibility policy and detail.
        store.db.exec('BEGIN');
        try {
          // Establish the read transaction before consulting a cached view/version.
          const prefs = store.preferences();
          const { data_version } = store.db.prepare('PRAGMA data_version').get() as {
            data_version: number;
          };
          const key = `${policy}:${data_version}`;
          let view = views.get(key);
          if (!view) {
            const sessions = store
              .list()
              .filter((s) => config.projects.includes('*') || config.projects.includes(s.project));
            if (sessions.length > 900) {
              send(413, { error: 'too-many-sessions' });
              return;
            }
            const exported = sessions.map((s) => exportSession(s, sessions));
            view = {
              sessions: exported,
              ids: Object.fromEntries(sessions.map((s) => [wireId(s.id), s.id])),
              paused: prefs.paused,
              signature: wireId(JSON.stringify([exported, prefs.paused])),
            };
            views.set(key, view);
          }
          if (url.pathname.endsWith('/detail')) {
            if (!config.conversation) {
              send(403, { error: 'conversation-disabled' });
              return;
            }
            const parsed = idSchema.safeParse(url.searchParams.get('id'));
            const s = parsed.success ? view.sessions.find((x) => x.id === parsed.data) : null;
            if (!s) {
              send(404, { error: 'not-found' });
              return;
            }
            const limit = Number(url.searchParams.get('limit') ?? 180);
            if (!Number.isInteger(limit) || limit < 1 || limit > 180) {
              send(400, { error: 'invalid-page' });
              return;
            }
            const detail = store.exportDetail(view.ids[s.id], {
              limit,
              view: url.searchParams.get('view') === 'conversation' ? 'conversation' : 'all',
            });
            // Truncate each event before applying the aggregate budget, so a huge
            // final tool output cannot evict the entire conversation.
            const exported = exportSession(
              { ...detail, partial: detail.partial || !!detail.olderEvents },
              [],
              true,
            );
            // New readers opt into the bounded view. Older readers retain their v1 window.
            const events = url.searchParams.has('view')
              ? remoteEventWindow(exported.events)
              : exported.events;
            const session = {
              ...exported,
              events,
              partial: exported.partial || events.length < exported.events.length,
              parentId: s.parentId,
              workspace: s.workspace,
            };
            const revision = wireId(JSON.stringify(session));
            // Authorization and current sharing scope were checked above, even for cache hits.
            if (url.searchParams.get('since') === revision)
              send(200, { officeId: config.officeId, unchanged: true, revision });
            else send(200, { officeId: config.officeId, session });
            return;
          }
          const version = versions.update(view.signature, view.sessions);
          const common = {
            officeId: config.officeId,
            epoch,
            version,
            sampledAt: Date.now(),
            paused: view.paused,
            conversation: config.conversation,
          };
          if (
            url.searchParams.get('epoch') === epoch &&
            url.searchParams.get('version') === String(version)
          ) {
            send(200, { unchanged: true, ...common });
          } else {
            const snapshot: WireSnapshot = { protocol: 1, ...common, sessions: view.sessions };
            const delta =
              url.searchParams.get('delta') === '1'
                ? versions.delta(
                    snapshot,
                    url.searchParams.get('epoch'),
                    url.searchParams.get('version'),
                  )
                : undefined;
            // Small offices or broad changes can cost less as a whole snapshot.
            send(
              200,
              delta && JSON.stringify(delta).length < JSON.stringify(snapshot).length
                ? delta
                : snapshot,
            );
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
    clearInterval(expiry);
    views.clear();
    store.close();
    throw e;
  }
  return {
    server,
    close: async () => {
      clearInterval(expiry);
      views.clear();
      versions.clear();
      await commands.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

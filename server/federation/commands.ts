import { DatabaseSync } from 'node:sqlite';
import { chmodSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { OfficeStore } from '../store.js';
import { idSchema, wireId, type ExportConfig } from './protocol.js';
import { nativePeerSender, type PeerSender } from './sender.js';

const inputSchema = z
  .object({
    epoch: z.uuid(),
    requestId: z.uuid(),
    id: idSchema,
    text: z.string().trim().min(1).max(20000),
  })
  .strict();
class CommandError extends Error {
  constructor(readonly status: number) {
    super('command-rejected');
  }
}
const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new CommandError(415);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128000) throw new CommandError(413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CommandError(400);
  }
}
/** Separate command credential and durable attempt journal. A pending attempt is NEVER replayed. */
export class PeerCommands {
  private epoch = randomUUID();
  private db?: DatabaseSync;
  private active = new Set<string>();
  private operations = new Set<Promise<void>>();
  private closing = false;
  constructor(
    private dir: string,
    private store: OfficeStore,
    private config: () => ExportConfig,
    private sender = nativePeerSender,
  ) {}
  private authorize(req: IncomingMessage) {
    const c = this.config();
    if (
      !c.enabled ||
      !c.allowSend ||
      !c.sendToken ||
      !equal(req.headers.authorization ?? '', `Bearer ${c.sendToken}`)
    )
      throw new CommandError(403);
    // Respect the owning computer's existing setting; never modify it from the network.
    try {
      if (
        JSON.parse(readFileSync(path.join(c.profileDir!, 'terminal-send.json'), 'utf8')).enabled ===
        false
      )
        throw new CommandError(403);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new CommandError(403);
    }
    return c;
  }
  /** Read the shared view once per batch, before and after asynchronous owner lookup. */
  private sessions(req: IncomingMessage, ids: string[]) {
    const c = this.authorize(req);
    const shared = new Map(
      this.store
        .list()
        .filter((s) => c.projects.includes('*') || c.projects.includes(s.project))
        .map((s) => [wireId(s.id), s]),
    );
    return ids.map((id) => {
      const s = shared.get(id);
      if (!s) throw new CommandError(404);
      return s;
    });
  }
  private session(req: IncomingMessage, id: string) {
    return this.sessions(req, [id])[0];
  }
  private journal() {
    if (!this.db) {
      const file = path.join(this.dir, 'commands.sqlite');
      this.db = new DatabaseSync(file);
      chmodSync(file, 0o600);
      this.db.exec(
        'PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL)',
      );
    }
    return this.db;
  }
  async handle(req: IncomingMessage, res: ServerResponse, route: string) {
    const reply = (status: number, value: unknown) => {
      if (!res.destroyed) {
        res.writeHead(status);
        res.end(JSON.stringify(value));
      }
    };
    try {
      if (this.closing || req.method !== 'POST' || req.headers.origin) throw new CommandError(403);
      const config = this.authorize(req);
      const value = await body(req);
      this.authorize(req);
      if (route === '/office/v1/commands/targets') {
        const { ids } = z
          .object({ ids: z.array(idSchema).max(20) })
          .strict()
          .parse(value);
        const sessions = this.sessions(req, ids);
        const targets = Object.fromEntries(
          await Promise.all(
            sessions.map(async (s, index) => {
              const id = ids[index];
              const t = await this.sender.target(s);
              return [
                id,
                t
                  ? {
                      kind: t.kind,
                      status: t.status.slice(0, 80),
                      canSend: t.canSend,
                      ...(t.queues !== undefined ? { queues: t.queues } : {}),
                    }
                  : null,
              ];
            }),
          ),
        );
        this.sessions(req, ids); // Recheck revocation and visibility after every target resolves.
        reply(200, { officeId: config.officeId, epoch: this.epoch, targets });
        return;
      }
      if (route !== '/office/v1/commands/send') throw new CommandError(404);
      const command = inputSchema.parse(value);
      const s = this.session(req, command.id);
      const db = this.journal();
      const digest = wireId(JSON.stringify([command.id, command.text]));
      const old = db
        .prepare('SELECT digest, status FROM attempts WHERE id = ?')
        .get(command.requestId) as { digest: string; status: string } | undefined;
      if (old) {
        if (old.digest !== digest) throw new CommandError(409);
        reply(200, {
          officeId: config.officeId,
          requestId: command.requestId,
          status: old.status === 'sent' ? 'sent' : 'uncertain',
        });
        return;
      }
      if (command.epoch !== this.epoch || this.active.has(command.id)) throw new CommandError(409);
      // Retain all IDs to prevent a replay after pruning; stop accepting after the bounded journal fills.
      if ((db.prepare('SELECT count(*) AS n FROM attempts').get() as { n: number }).n >= 100000)
        throw new CommandError(507);
      db.prepare("INSERT INTO attempts VALUES (?, ?, 'pending', ?)").run(
        command.requestId,
        digest,
        Date.now(),
      );
      this.active.add(command.id);
      let status: 'sent' | 'uncertain' = 'uncertain';
      const operation = (async () => {
        try {
          await this.sender.send(s, command.text, () => {
            this.session(req, command.id);
          });
          status = 'sent';
        } catch {
          /* Never echo native errors or suggest an automatic retry after a partial send. */
        } finally {
          db.prepare('UPDATE attempts SET status = ? WHERE id = ?').run(status, command.requestId);
          this.active.delete(command.id);
        }
      })();
      this.operations.add(operation);
      try {
        await operation;
      } finally {
        this.operations.delete(operation);
      }
      reply(200, { officeId: config.officeId, requestId: command.requestId, status });
    } catch (e) {
      reply(e instanceof CommandError ? e.status : e instanceof z.ZodError ? 400 : 503, {
        error: 'command-rejected',
      });
    }
  }
  async close() {
    this.closing = true;
    await Promise.allSettled(this.operations);
    this.db?.close();
  }
}

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { OfficeStore } from '../store.js';
import { idSchema, wireId, type ExportConfig } from './protocol.js';
import { nativePeerSender, type PeerSender } from './sender.js';
import { launchSpecSchema } from '../../src/shared/remote-launch.js';
import { launchDirectory, nativePeerLauncher, type PeerLauncher } from './launcher.js';
import { TargetProbes } from './target-probes.js';

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
  private probes: TargetProbes;
  constructor(
    private dir: string,
    private store: OfficeStore,
    private config: () => ExportConfig,
    private sender = nativePeerSender,
    private launcher: PeerLauncher = nativePeerLauncher(),
  ) {
    this.probes = new TargetProbes(sender);
  }
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
      if (route === '/office/v1/commands/launch-status' || route === '/office/v1/commands/launch') {
        const starting = route.endsWith('/launch');
        const base = z.object({ id: idSchema, spec: launchSpecSchema }).strict();
        const command = (
          starting ? base.extend({ epoch: z.uuid(), plan: idSchema, requestId: z.uuid() }) : base
        ).parse(value);
        const resolve = () => {
          const c = this.authorize(req);
          if (!c.allowLaunch || this.store.preferences().paused) throw new CommandError(403);
          const s = this.session(req, command.id);
          let cwd: string;
          try {
            cwd = launchDirectory(s);
          } catch {
            throw new CommandError(404);
          }
          return {
            c,
            s,
            cwd,
            plan: wireId(JSON.stringify([this.epoch, c, s.id, cwd, command.spec])),
          };
        };
        const first = resolve();
        const verify = () => {
          if (this.closing || resolve().plan !== first.plan) throw new CommandError(409);
        };
        const hosts = await this.launcher.status(first.cwd, command.spec);
        verify();
        const info = {
          officeId: first.c.officeId,
          epoch: this.epoch,
          plan: first.plan,
          project: first.s.project,
          cwd: first.cwd,
          hosts,
          status: 'ready',
        };
        if (!starting) {
          reply(200, info);
          return;
        }
        const start = command as z.infer<typeof base> & {
          epoch: string;
          plan: string;
          requestId: string;
        };
        const db = this.journal();
        db.exec(
          'CREATE TABLE IF NOT EXISTS launches (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT)',
        );
        const digest = wireId(JSON.stringify([command.id, command.spec]));
        const old = db
          .prepare('SELECT digest, result FROM launches WHERE id = ?')
          .get(start.requestId);
        if (old) {
          if (old.digest !== digest) throw new CommandError(409);
          reply(200, { ...info, requestId: start.requestId, status: old.result ?? 'uncertain' });
          return;
        }
        const key =
          'launch:' + wireId(JSON.stringify([first.cwd, command.spec.provider, command.spec.name]));
        if (
          start.epoch !== this.epoch ||
          start.plan !== first.plan ||
          !hosts[command.spec.host] ||
          this.active.has(key)
        )
          throw new CommandError(409);
        if (Number(db.prepare('SELECT count(*) AS n FROM launches').get()!.n) >= 100000)
          throw new CommandError(507);
        db.prepare('INSERT INTO launches VALUES (?, ?, NULL)').run(start.requestId, digest);
        this.active.add(key);
        let status = 'uncertain';
        const operation = (async () => {
          try {
            status = await this.launcher.start(first.cwd, command.spec, verify);
          } catch {
            /* An unacknowledged launch must never be replayed. */
          } finally {
            db.prepare('UPDATE launches SET result = ? WHERE id = ?').run(status, start.requestId);
            this.active.delete(key);
          }
        })();
        this.operations.add(operation);
        try {
          await operation;
        } finally {
          this.operations.delete(operation);
        }
        reply(200, { ...info, requestId: start.requestId, status });
        return;
      }
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
              const t = await this.probes.target(s);
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
        const latest = this.sessions(req, ids); // Recheck revocation and visibility after every target resolves.
        // Opt-in, send-authorized identity proof. Old receivers keep the exact v1 response.
        const codexThreads =
          req.headers['x-agent-office-codex-identities'] === '1'
            ? Object.fromEntries(
                latest.flatMap((s, i) =>
                  s.provider === 'codex' &&
                  ['root', 'fork'].includes(s.relation?.kind ?? 'root') &&
                  ['interactive', 'unknown'].includes(s.origin?.kind ?? 'unknown') &&
                  z.uuid().safeParse(s.nativeId).success &&
                  wireId(`codex:${s.nativeId}`) === ids[i]
                    ? [[ids[i], s.nativeId]]
                    : [],
                ),
              )
            : undefined;
        reply(200, {
          officeId: config.officeId,
          epoch: this.epoch,
          targets,
          ...(codexThreads ? { codexThreads } : {}),
        });
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
    this.probes.close();
    await Promise.allSettled(this.operations);
    this.db?.close();
  }
}

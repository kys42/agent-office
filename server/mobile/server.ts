import { m } from '../../src/shared/i18n/index.js';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
  DetailPage,
  SendResult,
  Session,
  SessionDetail,
  Snapshot,
  TerminalTarget,
} from '../../src/shared/types.js';
import type {
  MobileCommand,
  MobileSettings,
  MobileSnapshot,
  MobileDetail,
  MobileReceipt,
} from '../../src/shared/mobile.js';
import { sessionName } from '../../src/shared/office.js';
import { isVeiled } from '../../src/shared/veil.js';

export interface MobileBackend {
  snapshot(): Promise<Snapshot>;
  detail(id: string, page?: DetailPage): Promise<SessionDetail>;
  targets(ids: string[]): Promise<Record<string, TerminalTarget | null>>;
  send(id: string, text: string, authorized: () => Promise<void>): Promise<SendResult>;
  sendEnabled(): Promise<boolean>;
}
export function mobileAddresses() {
  return [
    '127.0.0.1',
    ...new Set(
      Object.values(networkInterfaces())
        .flat()
        .filter(
          (i) =>
            i?.family === 'IPv4' &&
            /^100\.(\d+)\./.test(i.address) &&
            +i.address.split('.')[1] >= 64 &&
            +i.address.split('.')[1] <= 127,
        )
        .map((i) => i!.address),
    ),
  ];
}
const settingsSchema = z
  .object({
    enabled: z.boolean(),
    address: z.string(),
    port: z.number().int().min(1024).max(65535),
    accessCode: z
      .string()
      .min(8)
      .max(64)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict();
const configureSchema = settingsSchema.omit({ accessCode: true });
const id = z.string().min(1).max(500);
const sendSchema = z
  .object({ id, text: z.string().trim().min(1).max(20000), requestId: z.uuid() })
  .strict();
const detailSchema = z
  .object({
    id,
    before: z
      .object({ at: z.number().finite(), id: z.string().max(1000) })
      .strict()
      .optional(),
  })
  .strict();
const code = () => randomBytes(24).toString('base64url');
const same = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
class Denied extends Error {
  constructor(readonly status: number) {
    super('Request rejected');
  }
}
async function body(req: IncomingMessage) {
  if (req.headers['content-type'] !== 'application/json') throw new Denied(415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128000) throw new Denied(413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new Denied(400);
  }
}
const visible = (s: Snapshot) =>
  s.preferences.privacy
    ? []
    : s.sessions.filter(
        (a) =>
          s.preferences.enabledProviders.includes(a.provider) &&
          !s.preferences.excludedProjects.includes(a.project) &&
          !isVeiled([a], s.notices ?? []),
      );

/** One opt-in listener owned by the desktop. No collector, generic RPC, or original DB writes. */
export class MobileServer {
  private config: z.infer<typeof settingsSchema> | null = null;
  private server?: http.Server;
  private error: string | null = null;
  private generation = 0;
  private sessions = new Map<string, { expires: number; count: number; minute: number }>();
  private loginWindow = { at: 0, count: 0 };
  private journal?: DatabaseSync;
  private active = new Set<string>();
  private operations = new Set<Promise<unknown>>();
  private queue: Promise<unknown> = Promise.resolve();
  private requests = 0;
  constructor(
    private dir: string,
    private assets: string,
    private backend: MobileBackend,
    private addresses = mobileAddresses,
  ) {}
  private file() {
    return path.join(this.dir, 'mobile-web.json');
  }
  state(): MobileSettings {
    const addresses = this.addresses();
    return {
      enabled: this.config?.enabled ?? false,
      address: this.config?.address ?? addresses.find((a) => a !== '127.0.0.1') ?? '127.0.0.1',
      port: this.config?.port ?? 4321,
      accessCode: this.config?.accessCode,
      addresses,
      running: !!this.server?.listening,
      url: this.server?.listening ? `http://${this.config!.address}:${this.config!.port}` : null,
      error: this.error,
    };
  }
  restore() {
    const task = this.queue.then(async () => {
      try {
        this.config = settingsSchema.parse(JSON.parse(await readFile(this.file(), 'utf8')));
        if (this.config.enabled) await this.start();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.error = m().mobile.configError;
      }
    });
    this.queue = task;
    return task;
  }
  command(command: MobileCommand): Promise<MobileSettings> {
    const next = this.queue.then(async () => {
      if (command?.action === 'state') return this.state();
      let next: z.infer<typeof settingsSchema>;
      if (command?.action === 'rotate' && this.config)
        next = { ...this.config, accessCode: code() };
      else if (command?.action === 'configure') {
        const { action: _, ...value } = command;
        next = { ...configureSchema.parse(value), accessCode: this.config?.accessCode ?? code() };
        if (next.enabled && !this.addresses().includes(next.address))
          throw new Error(m().mobile.addressError);
      } else throw new Error(m().mobile.invalidSettings);
      await this.stop();
      this.config = next;
      this.error = null;
      try {
        if (next.enabled) await this.start();
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        await writeFile(this.file() + '.tmp', JSON.stringify(next), { mode: 0o600 });
        await rename(this.file() + '.tmp', this.file());
      } catch {
        await this.stop();
        this.error = m().mobile.startError;
      }
      return this.state();
    });
    this.queue = next.catch(() => {});
    return next;
  }
  private async start() {
    const c = this.config!;
    if (!this.addresses().includes(c.address)) throw new Error('Address unavailable');
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.maxConnections = 32;
    server.keepAliveTimeout = 5000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(c.port, c.address, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', () => {
      this.error = m().mobile.webError;
    });
    this.server = server;
  }
  private async stop() {
    this.generation++;
    this.sessions.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  async close() {
    await this.queue.catch(() => {});
    await this.stop();
    await Promise.allSettled([...this.operations]);
    this.journal?.close();
    this.journal = undefined;
  }
  private authorize(req: IncomingMessage, generation: number) {
    if (!this.server?.listening || generation !== this.generation || !this.config?.enabled)
      throw new Denied(403);
    const token = /(?:^|;\s*)ao_mobile=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    const session = this.sessions.get(token);
    if (!session || session.expires < Date.now()) {
      this.sessions.delete(token);
      throw new Denied(401);
    }
    return session;
  }
  private async agent(req: IncomingMessage, generation: number, id: string, sending = false) {
    this.authorize(req, generation);
    const snapshot = await this.backend.snapshot();
    this.authorize(req, generation);
    const agent = visible(snapshot).find((a) => a.id === id);
    if (!agent || agent.remote?.stale || (sending && !(await this.backend.sendEnabled())))
      throw new Denied(403);
    this.authorize(req, generation);
    return agent;
  }
  private db() {
    if (!this.journal) {
      const file = path.join(this.dir, 'mobile-commands.sqlite');
      this.journal = new DatabaseSync(file);
      chmodSync(file, 0o600);
      this.journal.exec(
        'PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL)',
      );
    }
    return this.journal;
  }
  private async send(
    req: IncomingMessage,
    generation: number,
    value: unknown,
  ): Promise<MobileReceipt> {
    const input = sendSchema.parse(value);
    await this.agent(req, generation, input.id, true);
    const db = this.db();
    const digest = createHash('sha256')
      .update(JSON.stringify([input.id, input.text]))
      .digest('hex');
    const old = db.prepare('SELECT digest,status FROM attempts WHERE id=?').get(input.requestId) as
      { digest: string; status: MobileReceipt['status'] } | undefined;
    if (old) {
      if (old.digest !== digest) throw new Denied(409);
      return { requestId: input.requestId, status: old.status };
    }
    if (this.active.has(input.id)) throw new Denied(409);
    if ((db.prepare('SELECT count(*) AS n FROM attempts').get() as { n: number }).n >= 100000)
      throw new Denied(507);
    db.prepare("INSERT INTO attempts VALUES (?,?,'uncertain')").run(input.requestId, digest);
    this.active.add(input.id);
    const operation = (async () => {
      let status: MobileReceipt['status'] = 'uncertain';
      try {
        const result = await this.backend.send(input.id, input.text, async () => {
          await this.agent(req, generation, input.id, true);
        });
        status = result.status === 'sent' ? 'sent' : 'blocked';
      } catch {
        /* A partial send is never replayed, including after restarting the app. */
      } finally {
        this.active.delete(input.id);
      }
      db.prepare('UPDATE attempts SET status=? WHERE id=?').run(status, input.requestId);
      return { requestId: input.requestId, status };
    })();
    this.operations.add(operation);
    try {
      return await operation;
    } finally {
      this.operations.delete(operation);
    }
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const generation = this.generation;
    const reply = (status: number, data: unknown) => {
      if (!res.destroyed) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      }
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    this.requests++;
    try {
      if (this.requests > 24 || !this.config || !this.server?.listening) throw new Denied(503);
      const authority = `${this.config.address}:${this.config.port}`;
      if (req.headers.host !== authority) throw new Denied(403);
      const route = req.url ?? '';
      if (req.method === 'GET' && !route.startsWith('/mobile/api/')) {
        const file =
          route === '/' || route === '/mobile.html'
            ? 'mobile.html'
            : /^\/assets\/[\w.-]+$/.test(route)
              ? route.slice(1)
              : route === '/icon.png'
                ? 'icon.png'
                : null;
        if (!file) throw new Denied(404);
        const content = await readFile(path.join(this.assets, file)).catch(() => {
          throw new Denied(404);
        });
        const mime: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.woff2': 'font/woff2',
        };
        res.writeHead(200, {
          'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
        });
        res.end(content);
        return;
      }
      if (
        req.method !== 'POST' ||
        req.headers.origin !== `http://${authority}` ||
        req.headers['x-agent-office-mobile'] !== '1'
      )
        throw new Denied(403);
      if (route === '/mobile/api/login') {
        if (Date.now() - this.loginWindow.at > 60000)
          this.loginWindow = { at: Date.now(), count: 0 };
        if (++this.loginWindow.count > 20) throw new Denied(429);
        const { accessCode } = z
          .object({ accessCode: z.string().max(100) })
          .strict()
          .parse(await body(req));
        if (generation !== this.generation || !same(accessCode, this.config.accessCode))
          throw new Denied(401);
        for (const [key, session] of this.sessions)
          if (session.expires < Date.now()) this.sessions.delete(key);
        if (this.sessions.size >= 16) throw new Denied(429);
        const token = code();
        this.sessions.set(token, {
          expires: Date.now() + 12 * 3600000,
          count: 0,
          minute: Date.now(),
        });
        res.setHeader(
          'Set-Cookie',
          `ao_mobile=${token}; HttpOnly; SameSite=Strict; Path=/mobile/api; Max-Age=43200`,
        );
        reply(200, { ok: true });
        return;
      }
      const session = this.authorize(req, generation);
      if (Date.now() - session.minute > 60000) {
        session.minute = Date.now();
        session.count = 0;
      }
      if (++session.count > 240) throw new Denied(429);
      const value = await body(req);
      this.authorize(req, generation);
      let result: unknown;
      if (route === '/mobile/api/logout') {
        const token = /(?:^|;\s*)ao_mobile=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
        if (token) this.sessions.delete(token);
        res.setHeader(
          'Set-Cookie',
          'ao_mobile=; HttpOnly; SameSite=Strict; Path=/mobile/api; Max-Age=0',
        );
        reply(200, { ok: true });
        return;
      } else if (route === '/mobile/api/state') {
        const s = await this.backend.snapshot();
        result = {
          agents: visible(s).map((a: Session) => ({
            id: a.id,
            name: sessionName(a),
            provider: a.provider,
            project: a.area?.name ?? a.project,
            officeId: a.remote?.officeId ?? 'local',
            office: a.remote?.label ?? m().mobile.localOffice,
            tags: a.remote?.tags ?? [],
            status: a.status,
            updatedAt: a.updatedAt,
            preview: a.activity?.text ?? a.action ?? '',
            stale: a.remote?.stale ?? false,
            archived: !!a.archived,
          })),
          privacy: s.preferences.privacy,
          sendEnabled: await this.backend.sendEnabled(),
          at: Date.now(),
          lastSync: s.lastSync,
        } satisfies MobileSnapshot;
      } else if (route === '/mobile/api/detail') {
        const input = detailSchema.parse(value);
        await this.agent(req, generation, input.id);
        const detail = await this.backend.detail(input.id, {
          before: input.before?.id,
          beforeAt: input.before?.at,
          limit: 40,
        });
        await this.agent(req, generation, input.id);
        result = {
          id: input.id,
          events: detail.events.map(({ id, kind, phase, at, text, excerpt }) => ({
            id,
            kind,
            phase,
            at,
            text,
            excerpt,
          })),
          older: !!detail.olderEvents,
        } satisfies MobileDetail;
      } else if (route === '/mobile/api/targets') {
        const input = z
          .object({ ids: z.array(id).max(20) })
          .strict()
          .parse(value);
        for (const id of input.ids) await this.agent(req, generation, id);
        const targets = await this.backend.targets(input.ids);
        const enabled = await this.backend.sendEnabled();
        for (const id of input.ids) await this.agent(req, generation, id);
        result = Object.fromEntries(
          input.ids.map((id) => [
            id,
            targets[id]
              ? {
                  canSend: enabled && targets[id]!.canSend,
                  desktop: !!targets[id]!.desktop,
                  queues: !!targets[id]!.queues,
                }
              : null,
          ]),
        );
      } else if (route === '/mobile/api/receipt') {
        const { requestId } = z.object({ requestId: z.uuid() }).strict().parse(value);
        const row = this.db().prepare('SELECT status FROM attempts WHERE id=?').get(requestId) as
          { status: MobileReceipt['status'] } | undefined;
        result = { requestId, status: row?.status ?? 'uncertain' };
      } else if (route === '/mobile/api/send') result = await this.send(req, generation, value);
      else throw new Denied(404);
      this.authorize(req, generation);
      reply(200, result);
    } catch (e) {
      reply(e instanceof Denied ? e.status : e instanceof z.ZodError ? 400 : 503, {
        error: m().mobile.requestError,
      });
    } finally {
      this.requests--;
    }
  }
}

import { createServer, type Server } from 'node:net';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, copyFile, unlink, access } from 'node:fs/promises';
import { writeFileSync, renameSync, constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type {
  ManagerJob,
  ManagerRequest,
  ManagerSettings,
  ManagerState,
} from '../../src/shared/manager.js';
import { officeAction, READ_COMMANDS, type OfficeConnection } from './actions.js';
const exec = promisify(execFile);
const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('off') }).strict(),
  z.object({ kind: z.literal('hourly'), hours: z.number().int().min(1).max(24) }).strict(),
  z
    .object({ kind: z.literal('daily'), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) })
    .strict(),
]);
const settingsSchema = z
  .object({
    provider: z.enum(['codex', 'claude']),
    schedule: scheduleSchema,
    notifications: z.boolean(),
  })
  .strict();
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['status', 'start', 'stop', 'summary']) }).strict(),
  z
    .object({
      action: z.literal('chat'),
      text: z.string().trim().min(1).max(8000),
      selectedId: z.string().max(400).optional(),
    })
    .strict(),
  z.object({ action: z.literal('configure'), settings: settingsSchema }).strict(),
]);
export function nextSummaryAt(
  schedule: ManagerSettings['schedule'],
  now: number,
): number | undefined {
  if (schedule.kind === 'off') return undefined;
  if (schedule.kind === 'hourly') return now + schedule.hours * 3_600_000;
  const [hours, minutes] = schedule.time.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}
export async function findExecutable(name: string): Promise<string | undefined> {
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(os.homedir(), '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  const candidates = dirs.filter(Boolean).map((d) => path.join(d, name));
  if (name === 'codex')
    candidates.push(
      '/Applications/Codex.app/Contents/Resources/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    );
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
}
export const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
interface Saved {
  settings: ManagerSettings;
  jobs: ManagerJob[];
  sessionId?: string;
  createdAt?: number;
  ownedSessionIds?: string[];
  nextRunAt?: number;
  lastSummaryAt?: number;
  enabled?: boolean;
}
export class OfficeManager {
  private saved: Saved = {
    settings: { provider: 'codex', schedule: { kind: 'off' }, notifications: true },
    jobs: [],
  };
  private server?: Server;
  private socket = '';
  private runnerToken = '';
  private toolToken = '';
  private running = false;
  private heartbeatAt = 0;
  private startedAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private error?: string;
  private paths: Partial<Record<'tmux' | 'codex' | 'claude', string>> = {};
  private tail: Promise<unknown> = Promise.resolve();
  readonly dir: string;
  readonly tmuxName: string;
  private tmuxSocket: string;
  constructor(
    private options: {
      dataDir: string;
      bundleDir: string;
      node: string;
      office: OfficeConnection;
      notify: (job: ManagerJob) => void;
      executables?: Partial<Record<'tmux' | 'codex' | 'claude', string>>;
    },
  ) {
    this.dir = path.join(options.dataDir, 'manager');
    const key = createHash('sha256').update(this.dir).digest('hex').slice(0, 12);
    this.tmuxName = `office-manager-${key}`;
    this.tmuxSocket = `ao-manager-${key}`;
  }
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => {});
    return result;
  }
  private save() {
    if (this.saved.sessionId) {
      this.saved.ownedSessionIds = [
        ...new Set([
          ...(this.saved.ownedSessionIds ?? []),
          `${this.saved.settings.provider}:${this.saved.sessionId}`,
        ]),
      ];
    }
    const file = path.join(this.dir, 'state.json');
    writeFileSync(file + '.tmp', JSON.stringify(this.saved), { mode: 0o600 });
    renameSync(file + '.tmp', file);
  }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    try {
      const saved = JSON.parse(await readFile(path.join(this.dir, 'state.json'), 'utf8'));
      this.saved = {
        ...saved,
        settings: settingsSchema.parse(saved.settings),
        jobs: Array.isArray(saved.jobs) ? saved.jobs.slice(-100) : [],
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        this.error = 'Manager history could not be loaded.';
    }
    for (const job of this.saved.jobs)
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'failed';
        job.error = 'Office restarted. This request was not replayed.';
        job.finishedAt = Date.now();
      }
    for (const name of ['tmux', 'codex', 'claude'] as const)
      this.paths[name] = this.options.executables?.[name] ?? (await findExecutable(name));
    this.saved.createdAt ??= Date.now();
    this.save();
    if (this.saved.enabled)
      await this.start().catch((e) => {
        this.error = e.message;
      });
    this.timer = setInterval(() => {
      void this.serialized(() => this.tick()).catch((e) => {
        this.error = e.message;
      });
    }, 5000);
  }
  state(): ManagerState {
    return structuredClone({
      createdAt: this.saved.createdAt,
      settings: this.saved.settings,
      running: this.running,
      ready: this.running && Date.now() - this.heartbeatAt < 10_000,
      sessionId: this.saved.sessionId,
      ownedSessionIds: this.saved.ownedSessionIds ?? [],
      tmuxSession: this.running ? this.tmuxName : undefined,
      error: this.error,
      jobs: this.saved.jobs,
      nextRunAt: this.saved.nextRunAt,
      lastSummaryAt: this.saved.lastSummaryAt,
      availability: {
        tmux: !!this.paths.tmux,
        codex: !!this.paths.codex,
        claude: !!this.paths.claude,
      },
    });
  }
  async call(raw: ManagerRequest): Promise<ManagerState> {
    return this.serialized(async () => {
      const request = requestSchema.parse(raw);
      switch (request.action) {
        case 'status':
          break;
        case 'start':
          await this.start();
          break;
        case 'stop':
          await this.stop();
          break;
        case 'configure':
          if (this.running && request.settings.provider !== this.saved.settings.provider)
            throw new Error('Stop the manager before changing its agent.');
          if (request.settings.provider !== this.saved.settings.provider)
            this.saved.sessionId = undefined;
          this.saved.settings = request.settings;
          this.saved.nextRunAt = nextSummaryAt(request.settings.schedule, Date.now());
          this.save();
          break;
        case 'chat':
          if (request.selectedId) await this.options.office.call('detail', [request.selectedId]);
          this.enqueue('chat', request.text, request.selectedId);
          break;
        case 'summary':
          this.enqueue(
            'summary',
            'Summarize the current office. Respond in the Office locale returned by overview.',
          );
          break;
      }
      return this.state();
    });
  }
  private enqueue(kind: ManagerJob['kind'], text: string, selectedId?: string) {
    if (!this.running || Date.now() - this.heartbeatAt >= 10_000)
      throw new Error('Start the manager and wait until it is ready.');
    if (this.saved.jobs.filter((j) => j.status === 'queued' || j.status === 'running').length >= 10)
      throw new Error('Manager queue is full.');
    if (
      kind === 'summary' &&
      this.saved.jobs.some((j) => j.kind === 'summary' && ['queued', 'running'].includes(j.status))
    )
      throw new Error('A summary is already queued or running.');
    this.saved.jobs.push({
      id: randomUUID(),
      kind,
      text,
      selectedId,
      status: 'queued',
      createdAt: Date.now(),
      actions: [],
      ...(kind === 'summary' ? { since: this.saved.lastSummaryAt ?? Date.now() - 86_400_000 } : {}),
    });
    this.saved.jobs = this.saved.jobs.slice(-100);
    this.save();
  }
  private async start() {
    if (this.running) return;
    for (const name of ['tmux', this.saved.settings.provider] as const)
      this.paths[name] = this.options.executables?.[name] ?? (await findExecutable(name));
    const tmux = this.paths.tmux,
      executable = this.paths[this.saved.settings.provider];
    if (!tmux || !executable)
      throw new Error(
        `Install ${!tmux ? 'tmux' : this.saved.settings.provider} and sign in to the agent CLI, then try again.`,
      );
    const workspace = path.join(this.dir, 'workspace');
    await mkdir(path.join(workspace, '.agents/skills/office-manager'), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(path.join(workspace, '.claude/skills/office-manager'), {
      recursive: true,
      mode: 0o700,
    });
    for (const f of ['manager-runner.cjs', 'manager-cli.cjs'])
      await copyFile(path.join(this.options.bundleDir, f), path.join(this.dir, f));
    const skill = await readFile(
      path.join(this.options.bundleDir, 'office-manager.SKILL.md'),
      'utf8',
    );
    for (const folder of ['.agents', '.claude'])
      await writeFile(path.join(workspace, folder, 'skills/office-manager/SKILL.md'), skill);
    await writeFile(
      path.join(workspace, 'AGENTS.md'),
      'Use the office-manager skill at .agents/skills/office-manager/SKILL.md for every request. This workspace belongs only to Office Manager.\n',
    );
    await writeFile(
      path.join(workspace, 'CLAUDE.md'),
      'Use .claude/skills/office-manager/SKILL.md for every request.\n',
    );
    await writeFile(
      path.join(workspace, 'office'),
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(this.options.node)} ${quote(path.join(this.dir, 'manager-cli.cjs'))} ${quote(path.join(workspace, '.office-connection.json'))} "$@"\n`,
      { mode: 0o700 },
    );
    this.runnerToken = randomBytes(32).toString('hex');
    // Short private socket path also works when userData paths exceed macOS's socket limit.
    const socketDir = await import('node:fs/promises').then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), 'ao-manager-')),
    );
    await chmod(socketDir, 0o700);
    this.socket = path.join(socketDir, 'rpc.sock');
    this.server = createServer((client) => {
      client.setEncoding('utf8');
      let buffer = '',
        handled = false;
      client.setTimeout(55_000, () => client.destroy());
      client.on('error', () => {});
      client.on('data', (chunk) => {
        if (handled) return;
        buffer += chunk.toString();
        if (buffer.length > 100_000) {
          client.destroy();
          return;
        }
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        handled = true;
        void this.serialized(async () => {
          try {
            const data = JSON.parse(buffer.slice(0, end));
            const result = await this.dispatch(data);
            client.end(JSON.stringify({ result }) + '\n');
          } catch (e) {
            client.end(JSON.stringify({ error: (e as Error).message }) + '\n');
          }
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socket, resolve);
    });
    await chmod(this.socket, 0o600);
    const config = path.join(this.dir, 'runner.json');
    await writeFile(
      config,
      JSON.stringify({
        socket: this.socket,
        token: this.runnerToken,
        executable,
        provider: this.saved.settings.provider,
        workspace,
      }),
      { mode: 0o600 },
    );
    try {
      // A dedicated tmux server means existing user sessions are never selected or killed.
      await exec(tmux, ['-L', this.tmuxSocket, 'kill-session', '-t', this.tmuxName]).catch(
        () => {},
      );
      await exec(tmux, [
        '-L',
        this.tmuxSocket,
        '-f',
        '/dev/null',
        'new-session',
        '-d',
        '-s',
        this.tmuxName,
        '-c',
        workspace,
        `exec env ELECTRON_RUN_AS_NODE=1 ${quote(this.options.node)} ${quote(path.join(this.dir, 'manager-runner.cjs'))} ${quote(config)}`,
      ]);
      this.running = true;
      this.startedAt = Date.now();
      this.heartbeatAt = 0;
      this.error = undefined;
      this.saved.enabled = true;
      this.saved.nextRunAt ??= nextSummaryAt(this.saved.settings.schedule, Date.now());
      this.save();
    } catch (e) {
      await this.closeSocket();
      throw e;
    }
  }
  private async dispatch(data: { token?: string; command?: string; args?: any }) {
    if (!this.running) throw new Error('Manager is stopped.');
    const args = data.args ?? {};
    if (data.token === this.runnerToken) {
      if (data.command === 'heartbeat') {
        this.heartbeatAt = Date.now();
        return true;
      }
      if (data.command === 'take') {
        this.heartbeatAt = Date.now();
        if (this.saved.jobs.some((j) => j.status === 'running')) return null;
        const job = this.saved.jobs.find((j) => j.status === 'queued');
        if (!job) return null;
        job.status = 'running';
        job.startedAt = Date.now();
        this.toolToken = randomBytes(32).toString('hex');
        this.save();
        const prompt = `Use the office-manager skill at .agents/skills/office-manager/SKILL.md. Read it before acting. All Office access is through ./office.\n${job.kind === 'summary' ? `This is a read-only briefing. Report interval: ${new Date(job.since!).toISOString()} to ${new Date(job.startedAt).toISOString()}. Call overview with since=${job.since}.` : ''}\nSelected colleague ID: ${JSON.stringify(job.selectedId ?? null)}\nCurrent user request:\n${job.text}`;
        return {
          id: job.id,
          kind: job.kind,
          prompt,
          sessionId: this.saved.sessionId,
          toolToken: this.toolToken,
        };
      }
      if (data.command === 'progress') {
        const a = z.object({ jobId: z.string(), text: z.string().max(60000) }).parse(args);
        const job = this.saved.jobs.find((j) => j.id === a.jobId && j.status === 'running');
        if (job) {
          job.draftAnswer = a.text;
          this.save();
        }
        return true;
      }
      if (data.command === 'session') {
        const a = z.object({ jobId: z.string(), id: z.string().min(1).max(200) }).parse(args);
        if (this.saved.jobs.some((j) => j.id === a.jobId && j.status === 'running')) {
          this.saved.sessionId = a.id;
          this.save();
        }
        return true;
      }
      if (data.command === 'complete') {
        const a = z
          .object({
            id: z.string(),
            answer: z.string().max(60_000).optional(),
            error: z.string().max(5000).optional(),
            sessionId: z.string().max(200).optional(),
          })
          .parse(args);
        const job = this.saved.jobs.find((j) => j.id === a.id && j.status === 'running');
        if (!job) throw new Error('Request is no longer active.');
        job.status = a.error || !a.answer ? 'failed' : 'completed';
        job.answer = a.answer;
        job.error = a.error;
        job.finishedAt = Date.now();
        if (a.sessionId) this.saved.sessionId = a.sessionId;
        if (job.kind === 'summary' && job.status === 'completed')
          this.saved.lastSummaryAt = job.startedAt;
        this.toolToken = '';
        this.save();
        if (job.kind === 'summary' && this.saved.settings.notifications) this.options.notify(job);
        return true;
      }
      throw new Error('Unknown runner command.');
    }
    if (!this.toolToken || data.token !== this.toolToken)
      throw new Error('Office connection is not authorized for an active request.');
    const job = this.saved.jobs.find((j) => j.status === 'running');
    if (!job) throw new Error('No active manager request.');
    job.progress = data.command;
    this.save();
    const result = await officeAction(
      this.options.office,
      data.command ?? '',
      args,
      job.kind === 'summary',
    );
    if (result && typeof result === 'object' && 'display' in result) {
      job.cards ??= [];
      if (job.cards.length >= 12) throw new Error('Display limit reached for this request.');
      job.cards.push(result.display);
      this.save();
      return { shown: true };
    }
    if (!READ_COMMANDS.has(data.command!)) {
      job.actions.push({ command: data.command!, sessionId: args.id, at: Date.now() });
      this.save();
    }
    return result;
  }
  private async tick() {
    if (!this.running) return;
    if (Date.now() - Math.max(this.startedAt, this.heartbeatAt) > 20_000) {
      this.error = 'Manager disconnected. Pending requests were not replayed.';
      await this.stop();
      return;
    }
    if (
      this.saved.nextRunAt &&
      Date.now() >= this.saved.nextRunAt &&
      Date.now() - this.heartbeatAt < 10_000
    ) {
      if (
        !this.saved.jobs.some(
          (j) => j.kind === 'summary' && ['running', 'queued'].includes(j.status),
        )
      )
        this.enqueue(
          'summary',
          'Prepare the scheduled office briefing. Respond in the Office locale returned by overview.',
        );
      this.saved.nextRunAt = nextSummaryAt(this.saved.settings.schedule, Date.now());
      this.save();
    }
  }
  private async closeSocket() {
    this.server?.close();
    this.server = undefined;
    if (this.socket) {
      await unlink(this.socket).catch(() => {});
      await import('node:fs/promises')
        .then((fs) => fs.rmdir(path.dirname(this.socket)))
        .catch(() => {});
    }
  }
  private async stop(disable = true) {
    this.running = false;
    this.toolToken = '';
    this.runnerToken = '';
    if (this.paths.tmux)
      await exec(this.paths.tmux, [
        '-L',
        this.tmuxSocket,
        'kill-session',
        '-t',
        this.tmuxName,
      ]).catch(() => {});
    await this.closeSocket();
    for (const job of this.saved.jobs)
      if (['running', 'queued'].includes(job.status)) {
        job.status = 'failed';
        job.error = 'Manager stopped. This request was not replayed.';
        job.finishedAt = Date.now();
      }
    if (disable) this.saved.enabled = false;
    this.save();
  }
  async close() {
    clearInterval(this.timer);
    await this.serialized(() => this.stop(false));
  }
}

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { OfficeEvent, Session } from '../../src/shared/types.js';
import { summarizeActivity } from '../../src/shared/activity.js';
import { deriveState, runtimeObservation } from '../../src/shared/runtime.js';
import { CANONICAL, canonical } from '../../src/shared/canonical.js';
import { isResultOf } from '../../src/shared/notices.js';
import { hash, PLAN_APPROVAL_TOOL } from './normalize.js';

/*
 * Live Claude Code process state: `<claude config>/sessions/<pid>.json`, written by every
 * interactive CLI while it runs. It is a private, undocumented format, so every field is
 * validated, anything unexpected is ignored, and nothing here ever writes to it. The collector
 * reads it to see a permission prompt the transcript cannot show; the desktop shell reads it to
 * find a session's terminal and to type only into an idle one.
 */

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, for text that must not pass through argv parsing. */
  input?: string;
  timeout?: number;
}

export interface ClaudeLiveDeps {
  /** `${CLAUDE_CONFIG_DIR:-~/.claude}/sessions`. */
  sessionsDir: string;
  /** Rejections carry the command's stdout, e.g. a JSON refusal with a non-zero exit. */
  run: (file: string, args: string[], options?: RunOptions) => Promise<string>;
  alive: (pid: number) => boolean;
}

/** One record of `<claude config>/sessions/<pid>.json`. Undocumented CLI state; validate everything. */
export interface ClaudeProcess {
  pid: number;
  sessionId: string;
  procStart: string;
  /** Seen: `busy`, `idle`, `waiting`, `shell`. Only `idle` may receive typed input. */
  status: string;
  updatedAt: number;
  /** When `status` last changed (epoch ms), if the CLI wrote it. */
  statusUpdatedAt?: number;
  /** What a `waiting` process waits for, e.g. `permission prompt`. */
  waitingFor?: string;
}

export const runCommand: ClaudeLiveDeps['run'] = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout: options.timeout ?? 8000, maxBuffer: 1_000_000, env: options.env ?? process.env },
      (error, stdout) =>
        error ? reject(Object.assign(error, { stdout: String(stdout ?? '') })) : resolve(stdout),
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const defaultLiveDeps = (sessionsDir: string): ClaudeLiveDeps => ({
  sessionsDir,
  run: runCommand,
  alive: processAlive,
});

// Caches live per deps object: each app process shares one, and every test brings its own.
const memos = new WeakMap<object, Map<string, { at: number; value: Promise<unknown> }>>();
export function remember<T>(
  owner: object,
  key: string,
  ttl: number,
  fresh: boolean,
  make: () => Promise<T>,
): Promise<T> {
  let byKey = memos.get(owner);
  if (!byKey) memos.set(owner, (byKey = new Map()));
  const hit = byKey.get(key);
  if (!fresh && hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
  const value = make();
  byKey.set(key, { at: Date.now(), value });
  if (byKey.size > 500) byKey.delete(byKey.keys().next().value!);
  return value;
}
export const forget = (owner: object, key: string) => memos.get(owner)?.delete(key);

export const spaces = (value: string) => value.trim().replace(/\s+/g, ' ');

const epoch = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

export function parseClaudeProcess(file: string, text: string): ClaudeProcess | null {
  // A few hundred bytes in practice; anything large is not this format.
  if (text.length > 65_536) return null;
  try {
    const d = JSON.parse(text);
    const pid = Number(path.basename(file, '.json'));
    if (!Number.isInteger(pid) || pid <= 1 || d?.pid !== pid) return null;
    if (typeof d.sessionId !== 'string' || !/^[\w-]{8,80}$/.test(d.sessionId)) return null;
    if (typeof d.procStart !== 'string' || typeof d.status !== 'string') return null;
    if (d.kind !== undefined && d.kind !== 'interactive') return null;
    const statusUpdatedAt = epoch(d.statusUpdatedAt);
    const waitingFor =
      typeof d.waitingFor === 'string' && d.waitingFor.length <= 80
        ? spaces(d.waitingFor)
        : undefined;
    return {
      pid,
      sessionId: d.sessionId,
      procStart: d.procStart,
      status: d.status,
      updatedAt: epoch(d.updatedAt) ?? 0,
      ...(statusUpdatedAt ? { statusUpdatedAt } : {}),
      ...(waitingFor ? { waitingFor } : {}),
    };
  } catch {
    return null;
  }
}

/** Every well-formed record in the directory; a missing directory is simply none. */
export async function readClaudeProcesses(dir: string): Promise<ClaudeProcess[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const records = await Promise.all(
    files
      .filter((name) => /^\d+\.json$/.test(name))
      .slice(0, 1000)
      .map(async (name) =>
        parseClaudeProcess(name, await readFile(path.join(dir, name), 'utf8').catch(() => '')),
      ),
  );
  return records.filter((r): r is ClaudeProcess => !!r);
}

/**
 * The record's process is alive and is the one that wrote it: a recycled PID started at another
 * time. procStart is written in UTC with the C locale. A failed check is not remembered.
 */
export async function isLiveProcess(
  record: ClaudeProcess,
  deps: ClaudeLiveDeps,
  fresh = false,
): Promise<boolean> {
  if (!deps.alive(record.pid)) return false;
  const key = `lstart:${record.pid}:${record.procStart}`;
  const started = await remember(deps, key, 30_000, fresh, () =>
    deps
      .run('/bin/ps', ['-o', 'lstart=', '-p', String(record.pid)], {
        env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
      })
      .catch(() => ''),
  );
  if (!started.trim()) forget(deps, key);
  return !!started && spaces(started) === spaces(record.procStart);
}

/** The live interactive Claude Code process for a session, verified against PID reuse. */
export async function findClaudeProcess(
  sessionId: string,
  deps: ClaudeLiveDeps,
  fresh = false,
): Promise<ClaudeProcess | null> {
  // One directory read serves a burst of lookups (e.g. every bubble on the office floor).
  const records = await remember(deps, `records:${deps.sessionsDir}`, 1000, fresh, () =>
    readClaudeProcesses(deps.sessionsDir),
  );
  const candidates = records.filter((r) => r.sessionId === sessionId);
  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const record of candidates) if (await isLiveProcess(record, deps, fresh)) return record;
  return null;
}

/**
 * Sessions whose live, verified process is waiting for the person right now, by native session
 * id (newest record first). Only `wanted` sessions are verified, so a pass costs one directory
 * read and, while something waits, one memoized `ps` per process.
 */
export async function waitingClaudeProcesses(
  deps: ClaudeLiveDeps,
  wanted: ReadonlySet<string>,
): Promise<Map<string, ClaudeProcess>> {
  const found = new Map<string, ClaudeProcess>();
  const records = (await readClaudeProcesses(deps.sessionsDir))
    .filter((r) => r.status === 'waiting' && wanted.has(r.sessionId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const record of records)
    if (!found.has(record.sessionId) && (await isLiveProcess(record, deps)))
      found.set(record.sessionId, record);
  return found;
}

/**
 * The latest tool call of the current turn that has no result yet: what a permission prompt
 * is about. Calls of an earlier turn never count.
 */
export function pendingToolIndex(events: OfficeEvent[]): number {
  const boundary = events.findLastIndex((e) => e.kind === 'user' || e.lifecycle === 'started');
  const results = events.filter((e) => e.kind === 'result');
  return events.findLastIndex(
    (e, i) => i > boundary && e.kind === 'tool' && !results.some((r) => isResultOf(r, e)),
  );
}

/**
 * A session whose live process waits for the person (a permission prompt, or a plan to
 * approve) is calling, whatever its transcript last said. Applied on every pass after the parse
 * cache: the wait changes without the transcript changing. Null when the record is not this
 * session's, not waiting, or stale: the transcript recorded progress (a result, a message, a
 * turn boundary) after the status was written. Tool calls streamed in the same reply after the
 * prompt opened do not make it stale.
 */
export function applyLiveWait(s: Session, live: ClaudeProcess, now = Date.now()): Session | null {
  if (live.status !== 'waiting' || live.sessionId !== s.nativeId) return null;
  const since = live.statusUpdatedAt ?? live.updatedAt;
  if (!since || s.events.some((e) => e.kind !== 'tool' && e.at > since)) return null;
  const target = pendingToolIndex(s.events);
  const pending = target >= 0 ? s.events[target] : undefined;
  // The pending call is what the prompt asks about: the same attention notice as a question.
  const events =
    pending && pending.intent !== 'request-input'
      ? s.events.map((e, i) => (i === target ? { ...e, intent: 'request-input' as const } : e))
      : s.events;
  const t = canonical().server.reason;
  const reason =
    pending && PLAN_APPROVAL_TOOL.test(pending.tool ?? '')
      ? t.planApproval
      : /permission/i.test(live.waitingFor ?? '')
        ? t.permissionPrompt
        : t.liveWaiting;
  const state = deriveState('call', s.updatedAt, now, false, undefined, undefined, CANONICAL);
  const activity = summarizeActivity(events, 'call', s.updatedAt, CANONICAL);
  return {
    ...s,
    events,
    status: state.status,
    observedStatus: 'call',
    runtime: runtimeObservation('call', Math.max(s.updatedAt, since), reason),
    statusEvidence: state.reason ? 'derived' : 'observed',
    statusReason: state.reason ?? reason,
    activity,
    action: activity.text,
    revision: hash(`${s.revision}:live-wait:${live.pid}:${since}:${reason}:${pending?.id ?? ''}`),
  };
}

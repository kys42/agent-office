import { access, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { TerminalTarget } from '../src/shared/types.js';
import {
  cleanInput,
  defaultTerminalDeps,
  spaces,
  TerminalInputError,
  type TerminalDeps,
} from './terminals.js';

/**
 * Codex CLI sessions run inside one shared app-server daemon; a terminal screen is only a
 * client. `codex queue` hands a message to that daemon, which runs it now or after the current
 * turn, and every attached screen shows it — no terminal typing involved.
 *
 * Only threads the daemon has loaded are targets. For an unloaded thread the daemon accepts the
 * message but keeps it until the session is reopened, which would look like nothing happened.
 * Desktop-app (`Codex Desktop`) and headless (`codex_exec`) sessions are excluded: the app runs
 * its own server, and exec runs have no one to read the answer.
 */
export interface CodexThread {
  threadId: string;
}

const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CodexOrigin {
  originator?: string;
  subagent: boolean;
}

/** The rollout's `session_meta`: who started the session. Fixed for its life. */
export async function readCodexOrigin(file: string): Promise<CodexOrigin | null> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.alloc(1 << 16);
    let text = '';
    let lines = 0;
    // The meta line carries base instructions and can be large; stop after a few lines or 8 MiB.
    for (let offset = 0; offset < 8 << 20;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      text += decoder.write(chunk.subarray(0, bytesRead));
      for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n')) {
        const line = text.slice(0, nl).trim();
        text = text.slice(nl + 1);
        if (!line) continue;
        if (++lines > 5) return null;
        const d = JSON.parse(line);
        if (d?.type !== 'session_meta') continue;
        const p = d.payload ?? {};
        const source = p.source;
        return {
          originator: typeof p.originator === 'string' ? p.originator : undefined,
          subagent:
            source === 'subagent' ||
            (typeof source === 'object' && source !== null && 'subagent' in source),
        };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

const origins = new Map<string, Promise<CodexOrigin | null>>();
let daemon: { at: number; home: string; value: Promise<boolean> } | undefined;

/** `daemon.pid` names the running daemon; a stale file or a recycled pid fails the start time. */
export async function codexDaemonAlive(deps: TerminalDeps): Promise<boolean> {
  try {
    const record = JSON.parse(
      await readFile(path.join(deps.codexHome, 'app-server-daemon', 'daemon.pid'), 'utf8'),
    );
    const pid = record?.pid;
    if (!Number.isInteger(pid) || pid <= 1 || typeof record.processStartTime !== 'string')
      return false;
    if (!deps.alive(pid)) return false;
    const started = await deps.run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C' },
    });
    return spaces(started) === spaces(record.processStartTime);
  } catch {
    return false;
  }
}

export async function findCodexThread(
  nativeId: string,
  sourcePath: string | undefined,
  options: { fresh?: boolean; deps?: TerminalDeps } = {},
): Promise<CodexThread | null> {
  if (!THREAD.test(nativeId) || !sourcePath) return null;
  const deps = options.deps ?? defaultTerminalDeps();
  const loaded = await access(path.join(deps.codexHome, 'thread-writer-locks', `${nativeId}.lock`))
    .then(() => true)
    .catch(() => false);
  if (!loaded) return null;
  let origin = origins.get(sourcePath);
  if (!origin || options.deps) {
    origin = readCodexOrigin(sourcePath);
    origins.set(sourcePath, origin);
    if (origins.size > 500) origins.delete(origins.keys().next().value!);
  }
  const known = await origin;
  if (known?.originator !== 'codex-tui' || known.subagent) return null;
  if (
    !daemon ||
    options.fresh ||
    options.deps ||
    daemon.home !== deps.codexHome ||
    Date.now() - daemon.at > 10_000
  )
    daemon = { at: Date.now(), home: deps.codexHome, value: codexDaemonAlive(deps) };
  return (await daemon.value) ? { threadId: nativeId } : null;
}

export function codexTarget(): TerminalTarget {
  return {
    kind: 'codex',
    label: '',
    status: 'queue',
    canSend: true,
    canFocus: false,
    queues: true,
  };
}

export async function queueToCodex(
  thread: CodexThread,
  input: unknown,
  deps = defaultTerminalDeps(),
): Promise<string> {
  const text = cleanInput(input);
  // `--flag=value` keeps a message that starts with `-` from being read as an option.
  const out = await deps.run(
    deps.bin('codex'),
    ['queue', `--thread=${thread.threadId}`, `--message=${text}`],
    { timeout: 20_000 },
  );
  if (!out.includes(`for thread ${thread.threadId}`))
    throw new TerminalInputError('Codex가 메시지를 받았는지 확인하지 못했어요.');
  return 'Codex 세션에 전달했어요';
}

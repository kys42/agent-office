import { open } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { TerminalTarget } from '../src/shared/types.js';
import { m } from '../src/shared/i18n/index.js';
import {
  cleanInput,
  defaultTerminalDeps,
  TerminalInputError,
  type TerminalDeps,
} from './terminals.js';

/**
 * Codex CLI sessions are served by an app-server: the shared background daemon, or the TUI's
 * own embedded server (e.g. when started with `-c` overrides). `codex queue` puts a message in
 * Codex's shared queue; whichever server has the thread loaded takes it — now, or after the
 * current turn — and every attached screen shows it. No terminal typing is involved.
 *
 * Only threads some live Codex process holds open are targets: the serving process keeps
 * `thread-writer-locks/<id>.lock` open. A lock file alone proves nothing — it outlives its
 * session — and a message for a thread nobody serves just waits until the session is reopened,
 * which would look like nothing happened. Desktop-app (`Codex Desktop`) and headless
 * (`codex_exec`) sessions are excluded: the app runs its own server, and exec runs have no one
 * to read the answer.
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
let loaded: { at: number; home: string; value: Promise<Set<string>> } | undefined;

/** Threads whose lock a live Codex process holds open: one `lsof` over the lock folder (~0.1s). */
export async function codexLoadedThreads(deps: TerminalDeps): Promise<Set<string>> {
  const out = await deps
    .run('/usr/sbin/lsof', ['-Fcn', '+d', path.join(deps.codexHome, 'thread-writer-locks')])
    .catch((error: { stdout?: string }) => error.stdout ?? ''); // exit 1 when nothing is open
  const threads = new Set<string>();
  let command = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) command = '';
    else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n') && command === 'codex') {
      const m = /\/([0-9a-f-]{36})\.lock$/i.exec(line);
      if (m && THREAD.test(m[1])) threads.add(m[1].toLowerCase());
    }
  }
  return threads;
}

export async function findCodexThread(
  nativeId: string,
  sourcePath: string | undefined,
  options: { fresh?: boolean; deps?: TerminalDeps } = {},
): Promise<CodexThread | null> {
  if (!THREAD.test(nativeId) || !sourcePath) return null;
  const deps = options.deps ?? defaultTerminalDeps();
  let origin = options.deps ? undefined : origins.get(sourcePath);
  if (!origin) {
    origin = readCodexOrigin(sourcePath);
    // A failed read (file still being written, too many open files) is retried next time.
    if (!options.deps)
      origin.then((known) => {
        if (known) {
          origins.set(sourcePath, Promise.resolve(known));
          if (origins.size > 500) origins.delete(origins.keys().next().value!);
        }
      });
  }
  const known = await origin;
  if (known?.originator !== 'codex-tui' || known.subagent) return null;
  if (
    !loaded ||
    options.fresh ||
    options.deps ||
    loaded.home !== deps.codexHome ||
    Date.now() - loaded.at > 3000
  )
    loaded = { at: Date.now(), home: deps.codexHome, value: codexLoadedThreads(deps) };
  return (await loaded.value).has(nativeId.toLowerCase()) ? { threadId: nativeId } : null;
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
    // The command succeeded, so the message is likely queued; never invite a blind resend.
    throw new TerminalInputError(m().desktop.terminal.codexNoReply);
  return m().desktop.terminal.codexQueued;
}

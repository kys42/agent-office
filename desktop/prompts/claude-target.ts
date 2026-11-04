import { open } from 'node:fs/promises';
import type { SessionIdentity } from '../../src/shared/types.js';
import {
  defaultTerminalDeps,
  locateTerminal,
  promptHost,
  stillLive,
  type LiveTerminal,
  type TerminalDeps,
} from '../terminals.js';
import type { OpenCall, PromptTarget } from './types.js';

/*
 * A live Claude Code session as the prompt flow sees it: the terminal it owns (Orca or tmux,
 * desktop/terminals.ts), its process record (same pid, `waiting`, in front of its terminal) and
 * its transcript (which calls are open, whether one got its result). Read fresh on every use.
 */

export interface ClaudeTargetDeps extends TerminalDeps {
  /** The end of a transcript; reads the last 1 MB of the file by default. */
  readTail?: (file: string) => Promise<string>;
}

const TAIL = 1024 * 1024;

async function tail(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A cut start is half a record: skip to the first whole line.
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

type Obj = Record<string, any>;
function records(text: string): Obj[] {
  const out: Obj[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object') out.push(r);
    } catch {
      /* a line still being written */
    }
  }
  return out;
}

const blocks = (r: Obj): Obj[] => (Array.isArray(r.message?.content) ? r.message.content : []);
const isResult = (b: Obj) => b?.type === 'tool_result' && typeof b.tool_use_id === 'string';
/** A message the person wrote (not a tool result, not harness metadata): a turn boundary. */
const isPrompt = (r: Obj) =>
  r.type === 'user' &&
  !r.isMeta &&
  !r.isSidechain &&
  (typeof r.message?.content === 'string' ||
    blocks(r).some((b) => b?.type === 'text' && String(b.text ?? '').trim()));

/**
 * The calls of the current turn (after the person's last message) with no result yet, from
 * the main conversation (never a subagent's sidechain).
 */
export function openCallsIn(text: string): OpenCall[] {
  const all = records(text);
  const boundary = all.findLastIndex(isPrompt);
  const answered = new Set<string>();
  for (const r of all) for (const b of blocks(r)) if (isResult(b)) answered.add(b.tool_use_id);
  const calls: OpenCall[] = [];
  for (const r of all.slice(boundary + 1)) {
    if (r.type !== 'assistant' || r.isSidechain) continue;
    for (const b of blocks(r))
      if (
        b?.type === 'tool_use' &&
        typeof b.id === 'string' &&
        typeof b.name === 'string' &&
        b.input &&
        typeof b.input === 'object' &&
        !answered.has(b.id)
      )
        calls.push({
          id: b.id,
          tool: b.name,
          input: b.input,
          ...(typeof r.cwd === 'string' ? { cwd: r.cwd } : {}),
        });
  }
  return calls;
}

/** The transcript holds a tool result for exactly this call id (parsed, never a substring). */
export const resultIn = (text: string, callId: string) =>
  records(text).some((r) => blocks(r).some((b) => isResult(b) && b.tool_use_id === callId));

export function claudeTarget(
  live: LiveTerminal,
  transcript: string | undefined,
  deps: ClaudeTargetDeps = defaultTerminalDeps(),
): PromptTarget {
  const read = async () =>
    transcript ? await (deps.readTail ?? tail)(transcript).catch(() => null) : null;
  return {
    host: promptHost(live.host, deps),
    where: live.host.kind === 'orca' ? 'Orca' : `tmux ${live.host.label}`,
    waiting: live.process.status === 'waiting',
    async stillThere() {
      // A background session also needs its window still showing it (desktop/terminals.ts).
      return !!(await stillLive(live, deps, (status) => status === 'waiting').catch(() => null));
    },
    async openCalls() {
      const text = await read();
      return text === null ? null : openCallsIn(text);
    },
    async hasResult(callId) {
      const text = await read();
      return text === null ? null : resultIn(text, callId);
    },
  };
}

/** The live Claude Code session for a stored one, or null when no Orca/tmux terminal has it. */
export async function findClaudeTarget(
  session: SessionIdentity,
  fresh: boolean,
): Promise<PromptTarget | null> {
  const live = await locateTerminal(session.nativeId, { fresh });
  return live ? claudeTarget(live, session.sourcePath) : null;
}

import path from 'node:path';
import type { OfficeEvent, Provider, Session } from '../src/shared/types.js';
import { holdsFolder } from './orca-tabs.js';

/**
 * Orca puts a workspace to sleep after a while: its tabs stay (Orca brings them back once the
 * workspace is opened), but they have no terminal, so `orca terminal list` does not show them
 * and the duplicate check would call a resumed conversation absent there (#342). `orca worktree
 * ps` still lists each workspace's agents with the last request, the last answer and a title:
 * a saved conversation is matched to one of them by that text alone (there is no session id).
 * Read-only: nothing is sent to Orca or to any terminal.
 */

/** One agent of a workspace as `worktree ps` lists it (only what is compared). */
export interface OrcaPsAgent {
  agentType: string;
  paneKey: string;
  prompt?: string;
  lastAssistantMessage?: string;
  displayName?: string;
  taskTitle?: string;
}

/** One local workspace: its folder, its name, whether it sleeps, and its top-level agents. */
export interface OrcaPsWorkspace {
  path: string;
  name: string;
  /** No terminal attached (Orca shows its tabs again once the workspace is opened). */
  sleeping: boolean;
  agents: OrcaPsAgent[];
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * The local workspaces of a `worktree ps --json` answer, or null when it is not one. A
 * workspace sleeps when it has no attached terminal at all (`hasAttachedPty` false and no live
 * terminal): `isActive` only says which one is shown, a mounted one in the background has
 * terminals that `terminal list` sees. Sub-agents (`parentPaneKey`) are not tabs of their own.
 */
export function parseWorktreePs(answer: unknown): OrcaPsWorkspace[] | null {
  const result = (answer as { ok?: unknown; result?: { worktrees?: unknown } } | null) ?? null;
  if (result?.ok !== true || !Array.isArray(result.result?.worktrees)) return null;
  const rows: OrcaPsWorkspace[] = [];
  for (const raw of result.result.worktrees as Record<string, unknown>[]) {
    const folder = str(raw?.path);
    if (!folder || !path.isAbsolute(folder)) continue;
    if (raw.hostId !== undefined && raw.hostId !== 'local') continue;
    const live = typeof raw.liveTerminalCount === 'number' ? raw.liveTerminalCount : 0;
    const seen = new Set<string>();
    const agents: OrcaPsAgent[] = [];
    for (const a of Array.isArray(raw.agents) ? (raw.agents as Record<string, unknown>[]) : []) {
      const agentType = str(a?.agentType);
      const paneKey = str(a?.paneKey);
      if (!agentType || !paneKey || a.parentPaneKey || seen.has(paneKey)) continue;
      seen.add(paneKey);
      agents.push({
        agentType,
        paneKey,
        prompt: str(a.prompt),
        lastAssistantMessage: str(a.lastAssistantMessage),
        displayName: str(a.displayName),
        taskTitle: str(a.taskTitle),
      });
    }
    rows.push({
      path: path.resolve(folder),
      name: (str(raw.displayName) || str(raw.branch) || path.basename(folder)).slice(0, 80),
      sleeping: raw.hasAttachedPty !== true && live === 0,
      agents,
    });
  }
  return rows;
}

/** What Orca calls each agent (`agentType`), and its product name. Others are never matched. */
const ORCA_AGENTS: Partial<Record<Provider, { type: string; label: string }>> = {
  claude: { type: 'claude', label: 'Claude' },
  codex: { type: 'codex', label: 'Codex' },
};

/** What a saved conversation can be recognised by: its last request, last answer and titles. */
export interface ConversationClues {
  request?: string;
  answer?: string;
  titles: string[];
}

const lastText = (events: readonly OfficeEvent[] | undefined, kind: OfficeEvent['kind']) => {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--)
    if (events![i].kind === kind && events![i].text.trim()) return events![i].text;
  return undefined;
};

export type ClueSession = Pick<Session, 'provider' | 'cwd' | 'title' | 'alias'> &
  Partial<Pick<Session, 'id' | 'events'>>;

export function conversationClues(s: ClueSession): ConversationClues {
  return {
    request: lastText(s.events, 'user'),
    answer: lastText(s.events, 'assistant'),
    titles: [s.alias, s.title].filter((x): x is string => !!x?.trim()),
  };
}

/** Text as compared: NFC, one space, no trailing truncation mark. */
const norm = (text: string | undefined) =>
  (text ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(…|\.\.\.)$/, '')
    .trim();
/** The same text, or one cut short of the other: equal from 12 characters, a prefix from 24. */
const MIN_EQUAL = 12;
const MIN_PREFIX = 24;
/** A title Orca or the agent gives any tab, never evidence of one conversation. */
const GENERIC_TITLE = /^(claude( code)?|codex|terminal|shell|zsh|bash)$/i;
const MIN_TITLE = 4;

export function sameText(a: string | undefined, b: string | undefined): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return [...x].length >= MIN_EQUAL;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return [...short].length >= MIN_PREFIX && long.startsWith(short);
}

function sameTitle(a: string | undefined, b: string): boolean {
  const x = norm(a);
  return [...x].length >= MIN_TITLE && !GENERIC_TITLE.test(x) && x === norm(b);
}

/** Whether this agent shows this conversation: its last request, last answer or title agrees. */
export function cluesMatch(agent: OrcaPsAgent, clues: ConversationClues): boolean {
  return (
    sameText(agent.prompt, clues.request) ||
    sameText(agent.lastAssistantMessage, clues.answer) ||
    clues.titles.some((t) => sameTitle(agent.displayName, t) || sameTitle(agent.taskTitle, t))
  );
}

/**
 * The conversation in a sleeping Orca workspace:
 * - `found`: exactly one of the workspace's agents of its kind matches it, and that agent
 *   matches no other known conversation of the workspace.
 * - `unknown`: agents of its kind sleep there but none or several match (`count` of them).
 * - `none`: its folder is in no sleeping local workspace, or none of its kind sleeps there. A
 *   workspace with terminals is left to `terminal list` (the Orca tab check).
 */
export type SleepingLookup =
  | { kind: 'found'; workspace: string }
  | { kind: 'unknown'; workspace: string; count: number; agent: string }
  | { kind: 'none' };

export function matchSleeping(
  workspaces: readonly OrcaPsWorkspace[],
  session: ClueSession,
  others: Iterable<ClueSession> = [],
): SleepingLookup {
  const kind = ORCA_AGENTS[session.provider];
  if (!kind || !session.cwd || !path.isAbsolute(session.cwd)) return { kind: 'none' };
  const cwd = session.cwd;
  // The deepest workspace holding the folder: a nested worktree's tabs are its own.
  let home: OrcaPsWorkspace | undefined;
  for (const w of workspaces)
    if (holdsFolder(w.path, cwd) && (!home || w.path.length > home.path.length)) home = w;
  if (!home?.sleeping) return { kind: 'none' };
  const agents = home.agents.filter((a) => a.agentType === kind.type);
  if (!agents.length) return { kind: 'none' };
  const unknown = {
    kind: 'unknown',
    workspace: home.name,
    count: agents.length,
    agent: kind.label,
  } as const;
  const clues = conversationClues(session);
  const matched = agents.filter((a) => cluesMatch(a, clues));
  if (matched.length !== 1) return unknown;
  // Another conversation of this workspace that the same agent fits: it may be that one's.
  const rivals = [...others].filter(
    (o) =>
      o.provider === session.provider &&
      (o.id === undefined || o.id !== session.id) &&
      !!o.cwd &&
      path.isAbsolute(o.cwd) &&
      holdsFolder(home.path, o.cwd),
  );
  if (rivals.some((o) => cluesMatch(matched[0], conversationClues(o)))) return unknown;
  return { kind: 'found', workspace: home.name };
}

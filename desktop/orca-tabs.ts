import path from 'node:path';
import type { Provider, Session, TerminalTarget } from '../src/shared/types.js';
import { codexTitleThread } from './codex-focus.js';
import { focusTarget, orcaTerminals, type TerminalHostDeps } from './terminal-host.js';

/**
 * The Orca tab a saved conversation was last seen in, when no live agent process vouches for
 * a terminal (the agent exited, the tab was restored or is asleep). Such a tab is a place to
 * jump to, never a place to type: it may hold a bare shell. Sending keeps requiring the live
 * process lookup in desktop/terminals.ts.
 */
export type OrcaTabSession = Pick<Session, 'provider' | 'nativeId' | 'cwd' | 'title'> &
  Partial<Pick<Session, 'nativeTitle'>>;

export interface OrcaTab {
  kind: 'orca';
  handle: string;
  title: string;
}

/** How one agent names its Orca tab. Agents that never name it have no adapter. */
export interface OrcaTabAdapter {
  /** True only when the tab title is evidence of exactly this conversation. */
  names(title: string, session: OrcaTabSession): boolean;
}

/** Orca's attention title alternates these two markers while waiting for input. */
const ATTENTION = /^\[ [.!] \] Action Required \| /;
const text = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ');

/**
 * Claude Code titles its terminal "✳ <conversation title>" at rest and swaps the mark for a
 * spinner frame while working. The mark is required: a shell titled like the conversation is
 * no evidence. Only a title Claude itself gave the conversation (`nativeTitle`) is compared, so a
 * first-prompt fallback title never matches by chance; the generic "Claude Code" never does.
 */
export const claudeCodeTabs: OrcaTabAdapter = {
  names(title, session) {
    if (session.nativeTitle !== true || !session.title) return false;
    const shown = /^[✳✢✶✻✽·*⠀-⣿] (.+)$/u.exec(title.replace(ATTENTION, ''))?.[1];
    if (!shown || text(shown) === 'Claude Code') return false;
    return text(shown) === text(session.title);
  },
};

/** Codex puts the thread id first (full, or its 32-character abbreviation ending in "..."). */
export const codexTabs: OrcaTabAdapter = {
  names(title, session) {
    const reference = codexTitleThread(title);
    const id = session.nativeId.toLowerCase();
    if (!reference || !/^[0-9a-f-]{36}$/.test(id)) return false;
    return reference.endsWith('...') ? id.startsWith(reference.slice(0, -3)) : reference === id;
  },
};

const ADAPTERS: Partial<Record<Provider, OrcaTabAdapter>> = {
  claude: claudeCodeTabs,
  codex: codexTabs,
};
export const orcaTabsFor = (provider: Provider): OrcaTabAdapter | null =>
  ADAPTERS[provider] ?? null;

/**
 * The one Orca tab in the conversation's folder whose title names it. Conservative on purpose:
 * same worktree path as the session cwd, a title the agent's adapter recognises, a tab that is
 * still attached (`orphaned` terminals have none to switch to), on this machine, and not
 * claimed by another agent. A disconnected (`connected: false`) tab still counts: it is the
 * restored or sleeping tab the person can return to. None or several: no fallback.
 *
 * The title must also name this conversation alone: when another known conversation of the
 * same agent in the same folder fits the same tab (an equal Claude title, a Codex id
 * abbreviation they share), the tab may be the other one's, so there is no fallback either.
 */
export function matchOrcaTab(
  terminals: Iterable<Record<string, unknown>>,
  session: OrcaTabSession,
  others: Iterable<OrcaTabSession> = [],
  adapter: OrcaTabAdapter | null = orcaTabsFor(session.provider),
): OrcaTab | null {
  if (!adapter || !session.cwd || !path.isAbsolute(session.cwd)) return null;
  const cwd = path.resolve(session.cwd);
  const found: { tab: OrcaTab; title: string }[] = [];
  for (const t of terminals) {
    if (typeof t.handle !== 'string' || !/^term_[\w-]{1,80}$/.test(t.handle)) continue;
    if (t.orphaned === true || typeof t.tabId !== 'string' || !t.tabId) continue;
    if (t.executionHostId !== undefined && t.executionHostId !== 'local') continue;
    if (typeof t.agentIdentity === 'string' && t.agentIdentity !== session.provider) continue;
    if (
      typeof t.worktreePath !== 'string' ||
      !path.isAbsolute(t.worktreePath) ||
      path.resolve(t.worktreePath) !== cwd
    )
      continue;
    if (typeof t.title !== 'string' || !adapter.names(t.title, session)) continue;
    found.push({
      tab: { kind: 'orca', handle: t.handle, title: t.title.slice(0, 120) },
      title: t.title,
    });
  }
  if (found.length !== 1) return null;
  const { tab, title } = found[0];
  for (const other of others)
    if (
      other.nativeId !== session.nativeId &&
      other.provider === session.provider &&
      other.cwd &&
      path.isAbsolute(other.cwd) &&
      path.resolve(other.cwd) === cwd &&
      adapter.names(title, other)
    )
      return null;
  return tab;
}

/**
 * Looks the tab up in Orca's terminal list (shared 5 s cache with the live lookup). `others`:
 * every other conversation the office knows, for the uniqueness check above.
 */
export async function findOrcaTab(
  session: OrcaTabSession,
  deps: TerminalHostDeps,
  fresh = false,
  others: Iterable<OrcaTabSession> = [],
): Promise<OrcaTab | null> {
  if (!orcaTabsFor(session.provider)) return null;
  const terminals = await orcaTerminals(deps, fresh);
  return matchOrcaTab(terminals.values(), session, others);
}

/** A jump-only destination: nothing is ever typed into it. */
export function orcaTabTarget(tab: OrcaTab): TerminalTarget {
  return {
    kind: 'orca',
    label: tab.title,
    status: 'tab',
    canSend: false,
    canFocus: true,
    focus: focusTarget(tab),
    tabOnly: true,
  };
}

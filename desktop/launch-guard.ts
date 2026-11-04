import { findClaudeProcess } from '../server/adapters/claude-live.js';
import { m } from '../src/shared/i18n/index.js';
import type { DuplicateCheck, LaunchPlace, Provider } from '../src/shared/types.js';
import type { PendingState } from './pending-launch.js';
import type { SleepingLookup } from './orca-sleeping.js';
import { codexThreadOnScreen } from './codex-focus.js';
import type { TerminalLookup } from './terminal-host.js';
import { defaultTerminalDeps, lookupTerminal, type TerminalDeps } from './terminals.js';

/**
 * The deep check both launchers (tmux resume, a new Orca tab) run before resuming a saved
 * conversation, so one conversation never ends up running twice. The decision is pure
 * (`decideDuplicate`); how each agent proves it is alive lives in its liveness adapter.
 */

/** A tmux pane: its server's socket path and its pane id (`%N`). */
export interface TmuxPaneRef {
  socket: string;
  pane: string;
}
/** The app's own tmux session of a conversation: its server socket and its live panes. */
export interface OwnTmuxPanes {
  socket: string;
  panes: readonly string[];
}
/** The agent process of the conversation: `found` with where it runs (its pane in tmux). */
export type Liveness = TerminalLookup<{ where: LaunchPlace; tmux?: TmuxPaneRef }>;

/** Where a verified terminal is, for the duplicate check (its tmux pane when in tmux). */
const placeOfHost = (host: { kind: 'orca' } | { kind: 'tmux'; socket: string; pane: string }) =>
  host.kind === 'tmux'
    ? { where: host.kind, tmux: { socket: host.socket, pane: host.pane } }
    : { where: host.kind };

/** How one agent tells whether its process for a conversation is alive. */
export interface LivenessAdapter {
  lookup(nativeId: string, fresh: boolean, deps?: TerminalDeps): Promise<Liveness>;
}

/**
 * Claude: a verified live terminal (`lookupTerminal`), else any live process record of the
 * session (another terminal app, an unverified tmux pane): it runs, just not somewhere to jump.
 * `none` only after the absence check read every record.
 */
export const claudeLiveness: LivenessAdapter = {
  async lookup(nativeId, fresh, deps) {
    const terminal = await lookupTerminal(nativeId, { fresh, deps });
    if (terminal.kind === 'found')
      return { kind: 'found', terminal: placeOfHost(terminal.terminal.host) };
    if (terminal.kind === 'none') return terminal;
    // A window that parked this conversation in the background still holds it, and a
    // background session runs with no terminal: both are running, just nowhere to jump.
    const process = await findClaudeProcess(nativeId, deps ?? defaultTerminalDeps(), fresh, {
      parked: true,
    });
    return process ? { kind: 'found', terminal: { where: 'other' } } : { kind: 'unknown' };
  },
};

/**
 * Codex: any freshly verified interactive Codex screen showing this thread
 * (`codexThreadOnScreen`). Existence, not navigation: two screens of the thread, or one plus an
 * unreadable one, still mean it runs (`lookupCodexTerminal` calls that unknown).
 */
export const codexLiveness: LivenessAdapter = {
  async lookup(nativeId, fresh, deps) {
    const screen = await codexThreadOnScreen(nativeId, { fresh, deps });
    if (screen.kind === 'found')
      return { kind: 'found', terminal: placeOfHost(screen.terminal.host) };
    // Only macOS terminals (`ttys…`) are read; elsewhere (Linux `pts/…`) a Codex screen could
    // exist unseen, so its absence is never proven there.
    if (
      screen.kind === 'none' &&
      ((deps as { platform?: string } | undefined)?.platform ?? process.platform) !== 'darwin'
    )
      return { kind: 'unknown' };
    return screen;
  },
};

const ADAPTERS: Partial<Record<Provider, LivenessAdapter>> = {
  claude: claudeLiveness,
  codex: codexLiveness,
};
/** An agent without an adapter can never be shown absent. */
export const livenessFor = (provider: Provider): LivenessAdapter =>
  ADAPTERS[provider] ?? { lookup: async () => ({ kind: 'unknown' }) };

/** Everything the check looks at, each part already split into found / none / unknown. */
export interface LaunchEvidence {
  agent: Liveness;
  /** The conversation's Orca tab (`findOrcaTab` rules, `connected: false` tabs included). */
  orcaTab: TerminalLookup<unknown>;
  /**
   * The app's own tmux session for this conversation: `found` while its pane is alive, with
   * its panes when they could be listed (null: alive, panes unknown).
   */
  ownTmux: TerminalLookup<OwnTmuxPanes | null>;
  /**
   * A launch of it that may still start or started unseen (desktop/pending-launch.ts): Orca
   * made the tab, or Terminal/tmux was cut off after taking the command, but no terminal or
   * process shows it yet. It counts as open there (`true`: in Orca) until it expires, or until
   * the agent is seen running (`running` beats it). `starting`: the destination took it.
   */
  pending?: boolean | LaunchPlace | PendingState;
  /**
   * Its tab in a sleeping Orca workspace (desktop/orca-sleeping.ts): not in `terminal list`,
   * back once that workspace is opened. Left out: not looked for (a fork, Orca not answering).
   */
  orcaSleeping?: SleepingLookup;
}

/** The pure decision: running beats open beats unknown beats none. */
export function decideDuplicate(e: LaunchEvidence): DuplicateCheck {
  if (e.agent.kind === 'found') {
    // Only a verified terminal that is one of the own session's live panes puts it there: a
    // live own pane alone may show another conversation (after `/clear` or `/new`).
    const at = e.agent.terminal.tmux;
    const own = e.ownTmux.kind === 'found' ? e.ownTmux.terminal : null;
    const inOwnTmux = !!at && !!own && at.socket === own.socket && own.panes.includes(at.pane);
    return {
      state: 'running',
      where: e.agent.terminal.where,
      ...(inOwnTmux && { inOwnTmux: true as const }),
    };
  }
  if (e.orcaTab.kind === 'found') return { state: 'open', where: 'orca' };
  if (e.pending) {
    const held: PendingState =
      typeof e.pending === 'object'
        ? e.pending
        : { where: typeof e.pending === 'string' ? e.pending : 'orca' };
    return {
      state: 'open',
      where: held.where,
      pending: true,
      ...(held.starting && { starting: true as const }),
    };
  }
  const sleeping = e.orcaSleeping;
  if (sleeping?.kind === 'found')
    return { state: 'open', where: 'orca', sleeping: { workspace: sleeping.workspace } };
  // A live own pane is not proof of this conversation: after Claude `/clear` or Codex `/new`
  // the same process shows another one. Only the agent adapter above can say it runs.
  if (e.ownTmux.kind === 'found') return { state: 'open', where: 'tmux' };
  if (sleeping?.kind === 'unknown')
    return {
      state: 'unknown',
      sleeping: { workspace: sleeping.workspace, count: sleeping.count, agent: sleeping.agent },
    };
  if (e.agent.kind === 'unknown' || e.orcaTab.kind === 'unknown' || e.ownTmux.kind === 'unknown')
    return { state: 'unknown' };
  return { state: 'none' };
}

/** Where each part of the evidence comes from; a part that throws counts as `unknown`. */
export interface DuplicateDeps {
  agent: (fresh: boolean) => Promise<Liveness>;
  orcaTab: (fresh: boolean) => Promise<TerminalLookup<unknown>>;
  ownTmux: (fresh: boolean) => Promise<TerminalLookup<OwnTmuxPanes | null>>;
  /** Where a launch of it may still start, if anywhere (main-process memory, never throws). */
  pending?: () => boolean | LaunchPlace | PendingState | undefined;
  /**
   * Its tab in a sleeping Orca workspace. Unlike the others, a failure is no evidence (`none`):
   * Orca not running or not answering never blocks or cautions a launch.
   */
  orcaSleeping?: (fresh: boolean) => Promise<SleepingLookup>;
}

export async function checkDuplicate(deps: DuplicateDeps, fresh = false): Promise<DuplicateCheck> {
  const unknown = { kind: 'unknown' } as const;
  const [agent, orcaTab, ownTmux, orcaSleeping] = await Promise.all([
    deps.agent(fresh).catch(() => unknown),
    deps.orcaTab(fresh).catch(() => unknown),
    deps.ownTmux(fresh).catch(() => unknown),
    deps.orcaSleeping?.(fresh).catch((): SleepingLookup => ({ kind: 'none' })),
  ]);
  return decideDuplicate({ agent, orcaTab, ownTmux, orcaSleeping, pending: deps.pending?.() });
}

/**
 * The check for a fresh summon or a fork, which has no conversation to look for yet: only a
 * launch of the same one (agent, folder, name; a fork's original) that may still start.
 */
export const pendingCheck =
  (pending: () => boolean | LaunchPlace | PendingState | undefined) =>
  async (): Promise<DuplicateCheck> =>
    decideDuplicate({
      agent: { kind: 'none' },
      orcaTab: { kind: 'none' },
      ownTmux: { kind: 'none' },
      pending: pending(),
    });

const SEVERITY: Record<DuplicateCheck['state'], number> = {
  none: 0,
  unknown: 1,
  open: 2,
  running: 3,
};

export const placeName = (where: LaunchPlace) => m().tmux.place[where];

/** A launch refused because the conversation already runs, or changed after the confirmation. */
export class DuplicateLaunchError extends Error {
  constructor(readonly check: DuplicateCheck) {
    super(
      check.state === 'running'
        ? m().tmux.runningRefused(placeName(check.where))
        : m().tmux.changedRefused,
    );
  }
}

/**
 * The confirmation, framed by two fresh checks: one before asking (a running conversation is
 * refused without asking; the confirmation sees open/unknown to warn about), and one after,
 * since the dialog can stay open for minutes. Nothing the renderer saw earlier is trusted.
 * After confirming, a launch is refused when the conversation now runs, or looks worse than
 * what the person accepted (e.g. a tab opened meanwhile).
 */
export async function confirmLaunch(
  check: ((fresh: boolean) => Promise<DuplicateCheck>) | undefined,
  confirm: (check: DuplicateCheck) => Promise<boolean>,
): Promise<boolean> {
  if (!check) return confirm({ state: 'none' });
  const before = await check(true);
  if (before.state === 'running') throw new DuplicateLaunchError(before);
  if (!(await confirm(before))) return false;
  const after = await check(true);
  if (after.state === 'running' || SEVERITY[after.state] > SEVERITY[before.state])
    throw new DuplicateLaunchError(after);
  return true;
}

/** The warning added to a launcher's native confirmation ('' when nothing was found). */
export function duplicateNote(check: DuplicateCheck): string {
  const t = m().tmux;
  if (check.state === 'open' && check.sleeping)
    return '\n\n' + t.sleepingConfirm(check.sleeping.workspace);
  if (check.state === 'open') return '\n\n' + t.openConfirm(placeName(check.where));
  if (check.state === 'unknown' && check.sleeping)
    return '\n\n' + t.sleepingUnknownConfirm(check.sleeping.agent, check.sleeping.count);
  if (check.state === 'unknown') return '\n\n' + t.unknownConfirm;
  return '';
}

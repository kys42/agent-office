import { findClaudeProcess } from '../server/adapters/claude-live.js';
import { m } from '../src/shared/i18n/index.js';
import type { DuplicateCheck, LaunchPlace, Provider } from '../src/shared/types.js';
import { lookupCodexTerminal } from './codex-focus.js';
import type { TerminalLookup } from './terminal-host.js';
import { defaultTerminalDeps, lookupTerminal, type TerminalDeps } from './terminals.js';

/**
 * The deep check both launchers (tmux resume, a new Orca tab) run before resuming a saved
 * conversation, so one conversation never ends up running twice. The decision is pure
 * (`decideDuplicate`); how each agent proves it is alive lives in its liveness adapter.
 */

/** The agent process of the conversation: `found` with where it runs. */
export type Liveness = TerminalLookup<{ where: LaunchPlace }>;

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
      return { kind: 'found', terminal: { where: terminal.terminal.host.kind } };
    if (terminal.kind === 'none') return terminal;
    const process = await findClaudeProcess(nativeId, deps ?? defaultTerminalDeps(), fresh);
    return process ? { kind: 'found', terminal: { where: 'other' } } : { kind: 'unknown' };
  },
};

/** Codex: an interactive Codex screen showing this thread (`lookupCodexTerminal`). */
export const codexLiveness: LivenessAdapter = {
  async lookup(nativeId, fresh, deps) {
    const screen = await lookupCodexTerminal(nativeId, { fresh, deps });
    return screen.kind === 'found'
      ? { kind: 'found', terminal: { where: screen.terminal.host.kind } }
      : screen;
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
  /** The app's own tmux session for this conversation: `found` while its pane is alive. */
  ownTmux: TerminalLookup<unknown>;
}

/** The pure decision: running beats open beats unknown beats none. */
export function decideDuplicate(e: LaunchEvidence): DuplicateCheck {
  if (e.agent.kind === 'found') return { state: 'running', where: e.agent.terminal.where };
  if (e.orcaTab.kind === 'found') return { state: 'open', where: 'orca' };
  // A live own pane is not proof of this conversation: after Claude `/clear` or Codex `/new`
  // the same process shows another one. Only the agent adapter above can say it runs.
  if (e.ownTmux.kind === 'found') return { state: 'open', where: 'tmux' };
  if (e.agent.kind === 'unknown' || e.orcaTab.kind === 'unknown' || e.ownTmux.kind === 'unknown')
    return { state: 'unknown' };
  return { state: 'none' };
}

/** Where each part of the evidence comes from; a part that throws counts as `unknown`. */
export interface DuplicateDeps {
  agent: (fresh: boolean) => Promise<Liveness>;
  orcaTab: (fresh: boolean) => Promise<TerminalLookup<unknown>>;
  ownTmux: (fresh: boolean) => Promise<TerminalLookup<unknown>>;
}

export async function checkDuplicate(deps: DuplicateDeps, fresh = false): Promise<DuplicateCheck> {
  const unknown = { kind: 'unknown' } as const;
  const [agent, orcaTab, ownTmux] = await Promise.all([
    deps.agent(fresh).catch(() => unknown),
    deps.orcaTab(fresh).catch(() => unknown),
    deps.ownTmux(fresh).catch(() => unknown),
  ]);
  return decideDuplicate({ agent, orcaTab, ownTmux });
}

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
  if (check.state === 'open') return '\n\n' + t.openConfirm(placeName(check.where));
  if (check.state === 'unknown') return '\n\n' + t.unknownConfirm;
  return '';
}

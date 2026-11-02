import path from 'node:path';
import { m } from '../../src/shared/i18n/index.js';
import type { RunOptions } from '../../server/adapters/claude-live.js';
import {
  OrcaLaunch,
  shellCommand,
  shellQuote,
  type OrcaLaunchSession,
  type OrcaPlan,
} from '../orca-launch.js';
import { openInTerminalApp } from '../terminal-host.js';
import { TmuxResume, type SavedSession, type TmuxInspection } from '../tmux-resume.js';
import type { LaunchDestination, LaunchTarget } from './core.js';
import type { StartContext } from './pipeline.js';

/**
 * The launch destinations (#318). Each turns a `LaunchTarget` into its own terms and leaves the
 * order of things (confirmation, duplicates, queue, pending) to the pipeline:
 * - `tmux`: the app's dedicated tmux server (desktop/tmux-resume.ts); a new conversation or a
 *   fork takes a named slot, reused while it runs.
 * - `orca`: a new Orca tab (desktop/orca-launch.ts); `uncertain` when Orca did not confirm it.
 * - `terminalApp`: a new macOS Terminal window running the command (nothing to adopt: its
 *   process is found like any terminal's).
 * - `copy`: the command on the clipboard; nothing starts, so nothing is confirmed or pending.
 */

/** tmux's own terms: the session a summon, fork or resume runs in. */
export function tmuxSession(t: LaunchTarget): SavedSession {
  const provider = t.provider as SavedSession['provider'];
  const base = { provider, cwd: t.cwd, skipPermissions: t.skipPermissions };
  if (t.kind === 'resume') return { ...base, nativeId: t.nativeId ?? '' };
  return {
    ...base,
    nativeId: t.kind === 'fork' ? (t.nativeId ?? '') : 'new',
    ...(t.kind === 'fork' ? { fork: true } : { fresh: true }),
    agentName: t.name,
    initialMessage: t.initialMessage?.trim() ? t.initialMessage : undefined,
    sessionId: t.sessionId,
  };
}

/** Orca's terms: the tab's command, folder and title (the colleague's name or the title). */
export function orcaSession(t: LaunchTarget): OrcaLaunchSession {
  return {
    provider: t.provider,
    nativeId: t.kind === 'new' ? 'new' : (t.nativeId ?? ''),
    cwd: t.cwd,
    title: t.title ?? '',
    alias: t.name ?? '',
    skipPermissions: t.skipPermissions,
    ...(t.kind === 'new' && { fresh: true }),
    ...(t.kind === 'fork' && { fork: true }),
    ...(t.kind !== 'resume' && {
      sessionId: t.sessionId,
      initialMessage: t.initialMessage?.trim() ? t.initialMessage : undefined,
    }),
    background: t.background,
    executable: t.executable,
  };
}

export function tmuxDestination(tmux: TmuxResume): LaunchDestination {
  return {
    id: 'tmux',
    launches: true,
    place: 'tmux',
    async probe(t) {
      const probe = await tmux.probe(tmuxSession(t));
      return probe.running ? { ...probe, message: m().launch.tmuxRunning } : probe;
    },
    async start(t, context) {
      const started = await tmux.launch(tmuxSession(t), context as StartContext<TmuxInspection>);
      return started.state === 'launched'
        ? { ...started, message: m().launch.tmuxLaunched, command: started.detail?.command }
        : started;
    },
  };
}

export function orcaDestination(orca: OrcaLaunch): LaunchDestination {
  return {
    id: 'orca',
    launches: true,
    place: 'orca',
    probe: (t, fresh) => orca.probe(orcaSession(t), fresh),
    async start(t, context) {
      const started = await orca.create(orcaSession(t), context as StartContext<OrcaPlan>);
      // A new conversation is a new agent in its tab, not "this conversation".
      return started.state === 'launched' && t.kind !== 'resume'
        ? { ...started, message: m().tmux.summonOrcaLaunched }
        : started;
    },
  };
}

/** What Terminal.app and a copied command need: the agent CLI and the folder. */
export interface ShellDestinationDeps {
  platform: string;
  run: (file: string, args: string[], options?: RunOptions) => Promise<string>;
  directory: (cwd: string) => Promise<boolean>;
  /** The agent CLI's absolute path (throws when not found: the shell's PATH then decides). */
  binary?: (name: string) => Promise<string>;
  /** Agent Office's environment: the agent home it reads conversations from. */
  env?: NodeJS.ProcessEnv;
  /** Puts the text on the clipboard. */
  copy?: (text: string) => void;
}

/**
 * The command a person's shell runs for this launch: into the folder, then the agent, with the
 * same words as an Orca tab (`shellCommand`). `executable`: the resolved CLI, else its name.
 */
export function folderCommand(t: LaunchTarget, env: NodeJS.ProcessEnv, executable?: string) {
  return `cd ${shellQuote(t.cwd)} && ${shellCommand({ ...orcaSession(t), executable }, env)}`;
}

async function plan(t: LaunchTarget, deps: ShellDestinationDeps, resolve: boolean) {
  let executable = t.executable;
  if (!executable && resolve && deps.binary)
    executable = await deps.binary(t.provider).catch(() => undefined);
  const command = folderCommand(
    t,
    deps.env ?? process.env,
    executable && path.isAbsolute(executable) ? executable : undefined,
  );
  if (!(await deps.directory(t.cwd))) throw new Error(m().tmux.folderMissing);
  return command;
}

/**
 * What a failed `osascript … do script` call says about the command. Only a failure that
 * happened before Terminal could take it is a refusal: osascript could not start (`spawn`
 * error), macOS did not let us control Terminal (-1743, -1744: Automation not allowed), or no
 * Terminal app answered (-10814 not found, -600 not running). Anything else, our time limit
 * above all, may come after Terminal already opened the window and typed the command: killing
 * osascript does not undo that, so it is `uncertain`, never a refusal to retry.
 */
export function terminalAppFailure(error: unknown): 'denied' | 'failed' | 'uncertain' {
  const e = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
  if (e?.killed === true || !!e?.signal || e?.code === 'ETIMEDOUT') return 'uncertain';
  if (typeof e?.code === 'string' && /^(ENOENT|EACCES|EPERM)$/.test(e.code)) return 'failed';
  const text = typeof e?.message === 'string' ? e.message : '';
  if (/\((-1743|-1744)\)/.test(text)) return 'denied';
  if (/\((-10814|-600)\)/.test(text)) return 'failed';
  return 'uncertain';
}

export function terminalAppDestination(deps: ShellDestinationDeps): LaunchDestination {
  return {
    id: 'terminalApp',
    launches: true,
    place: 'other',
    async probe(t) {
      if (deps.platform !== 'darwin')
        return { available: false, reason: m().launch.terminalAppUnsupported };
      try {
        const command = await plan(t, deps, true);
        return { available: true, command, detail: command };
      } catch (error) {
        return { available: false, reason: (error as Error).message };
      }
    },
    async start(_t, context) {
      const command = context.probe.detail as string;
      context.authorized?.();
      try {
        await openInTerminalApp(deps.run, command);
      } catch (error) {
        const failure = terminalAppFailure(error);
        if (failure === 'denied') throw new Error(m().launch.terminalAppDenied);
        if (failure === 'failed') throw new Error(m().launch.terminalAppFailed);
        // Terminal may already be running it: held like an unconfirmed Orca tab, never retried.
        context.hold();
        return { state: 'uncertain', message: m().launch.terminalAppUncertain, command };
      }
      return { state: 'launched', message: m().launch.terminalAppLaunched, command };
    },
  };
}

export function copyDestination(deps: ShellDestinationDeps): LaunchDestination {
  return {
    id: 'copy',
    launches: false,
    async probe(t) {
      // A POSIX shell command: Windows shells read its quoting otherwise.
      if (deps.platform === 'win32')
        return { available: false, reason: m().launch.copyUnsupported };
      try {
        // The person's own shell: the agent by name, as they would type it.
        const command = await plan(t, deps, false);
        return { available: true, command, detail: command };
      } catch (error) {
        return { available: false, reason: (error as Error).message };
      }
    },
    async start(_t, context) {
      const command = context.probe.detail as string;
      deps.copy?.(command);
      return { state: 'copied', message: m().launch.copied, command };
    },
  };
}

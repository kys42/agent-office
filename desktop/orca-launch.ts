import path from 'node:path';
import { stat } from 'node:fs/promises';
import { remember, runCommand } from '../server/adapters/claude-live.js';
import { m } from '../src/shared/i18n/index.js';
import type { OrcaLaunchInfo, Session } from '../src/shared/types.js';
import { launchArgs } from './tmux-resume.js';

/**
 * Resumes a saved conversation in a new Orca terminal tab (`orca terminal create`). Orca types
 * `--command` into the tab's login shell, so every word of it is checked against a plain
 * character set and single-quoted; nothing else from the session reaches that shell. The
 * folder and title go to Orca as separate arguments, never through a shell.
 */
export type OrcaLaunchSession = Pick<Session, 'provider' | 'nativeId' | 'cwd'> &
  Partial<Pick<Session, 'title' | 'alias' | 'remote'>> & {
    /** The person's `tmuxSkipPermissions`: the same agent flags as a tmux launch. */
    skipPermissions?: boolean;
  };

export interface OrcaLaunchDeps {
  run: typeof runCommand;
  /** The Orca CLI's absolute path, or a bare name when it is not installed. */
  orca: () => string;
  directory: (cwd: string) => Promise<boolean>;
  platform: string;
}

const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
/** Words the shell reads literally even unquoted; anything else is refused, not escaped. */
const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One single-quoted shell word. */
export function shellWord(word: string): string {
  if (!word || CONTROL.test(word) || !PLAIN.test(word)) throw new Error(m().tmux.unsupported);
  return `'${word}'`;
}

function describe(s: OrcaLaunchSession, platform: string) {
  if (
    platform !== 'darwin' ||
    s.remote ||
    (s.provider !== 'claude' && s.provider !== 'codex') ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(s.nativeId)
  )
    throw new Error(m().tmux.orcaUnsupported);
  if (!s.cwd || !path.isAbsolute(s.cwd) || CONTROL.test(s.cwd))
    throw new Error(m().tmux.folderMissing);
  // The agent is looked up on the person's own login-shell PATH, as if they typed it there.
  const command = [s.provider, ...launchArgs({ ...s, fresh: false })].map(shellWord).join(' ');
  const shown = (s.alias || s.title || '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const name = shown.slice(0, 60) || `${s.provider} ${s.nativeId.slice(0, 8)}`;
  return { cwd: path.resolve(s.cwd), command, name };
}

/** The `orca` arguments for the launch; `--flag=value` so no value can pose as an option. */
export function orcaCreateArgs(s: OrcaLaunchSession, platform = 'darwin'): string[] {
  const { cwd, command, name } = describe(s, platform);
  return [
    'terminal',
    'create',
    `--worktree=path:${cwd}`,
    `--title=${name}`,
    `--command=${command}`,
    '--focus',
    '--json',
  ];
}

/** Orca's own explanation of a refusal, as plain one-line text. */
export function orcaRefusal(stdout: string | undefined): string {
  try {
    const error = JSON.parse(stdout ?? '')?.error;
    const step = Array.isArray(error?.data?.nextSteps) ? error.data.nextSteps[0] : undefined;
    const reason = [step, error?.message, error?.code].find(
      (x): x is string => typeof x === 'string' && !!x.trim(),
    );
    return reason ? reason.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').slice(0, 300) : '';
  } catch {
    return '';
  }
}

const defaults = (orca: () => string): OrcaLaunchDeps => ({
  run: runCommand,
  orca,
  directory: async (cwd) => (await stat(cwd).catch(() => null))?.isDirectory() ?? false,
  platform: process.platform,
});

export class OrcaLaunch {
  private queue: Promise<unknown> = Promise.resolve();
  private deps: OrcaLaunchDeps;
  constructor(deps: OrcaLaunchDeps | (() => string)) {
    this.deps = typeof deps === 'function' ? defaults(deps) : deps;
  }
  /** Orca installed and its runtime answering (`orca status`), checked at most every 5 s. */
  reachable(fresh = false): Promise<boolean> {
    return remember(this, 'orca-status', 5000, fresh, async () => {
      const orca = this.deps.orca();
      if (!path.isAbsolute(orca)) return false;
      try {
        const status = JSON.parse(
          await this.deps.run(orca, ['status', '--json'], { timeout: 5000 }),
        );
        return status?.ok === true && status.result?.runtime?.reachable === true;
      } catch {
        return false;
      }
    });
  }
  /** Read-only: whether the action can be offered, and the command it would type. */
  async status(s: OrcaLaunchSession): Promise<OrcaLaunchInfo> {
    try {
      const { cwd, command } = describe(s, this.deps.platform);
      if (!(await this.deps.directory(cwd)) || !(await this.reachable()))
        return { available: false };
      return { available: true, command };
    } catch {
      return { available: false };
    }
  }
  start(
    s: OrcaLaunchSession,
    confirm: (info: { name: string; cwd: string; command: string }) => Promise<boolean>,
  ): Promise<OrcaLaunchInfo> {
    const task = this.queue.then(async () => {
      const t = m().tmux;
      const info = describe(s, this.deps.platform);
      if (!(await this.deps.directory(info.cwd))) throw new Error(t.folderMissing);
      if (!(await this.reachable(true))) throw new Error(t.orcaUnavailable);
      if (!(await confirm(info)))
        return { available: true, command: info.command, launched: false };
      if (!(await this.deps.directory(info.cwd))) throw new Error(t.folderMissing);
      let out: string;
      try {
        out = await this.deps.run(this.deps.orca(), orcaCreateArgs(s, this.deps.platform), {
          timeout: 20000,
        });
      } catch (error) {
        throw new Error(t.orcaRefused(orcaRefusal((error as { stdout?: string }).stdout)));
      }
      let ok = false;
      try {
        ok = JSON.parse(out)?.ok === true;
      } catch {
        /* not Orca's JSON */
      }
      if (!ok) throw new Error(t.orcaRefused(orcaRefusal(out)));
      return { available: true, command: info.command, launched: true, message: t.orcaLaunched };
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}

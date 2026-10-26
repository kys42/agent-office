import path from 'node:path';
import { stat } from 'node:fs/promises';
import { remember, runCommand } from '../server/adapters/claude-live.js';
import { m } from '../src/shared/i18n/index.js';
import type { DuplicateCheck, OrcaLaunchInfo, Session } from '../src/shared/types.js';
import { confirmLaunch } from './launch-guard.js';
import { launchArgs } from './tmux-resume.js';
import { localOrcaEnv } from './terminal-host.js';
export { localOrcaEnv };

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
    fresh?: boolean;
    initialMessage?: string;
    background?: boolean;
    /** Locally resolved CLI; never supplied by a remote request. */
    executable?: string;
  };

export interface OrcaLaunchDeps {
  run: typeof runCommand;
  /** The Orca CLI's absolute path, or a bare name when it is not installed. */
  orca: () => string;
  directory: (cwd: string) => Promise<boolean>;
  platform: string;
  /** Agent Office's own environment: the agent home it reads conversations from. */
  env?: NodeJS.ProcessEnv;
}

const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
/** Words the shell reads literally even unquoted; anything else is refused, not escaped. */
const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One single-quoted shell word. */
export function shellWord(word: string): string {
  if (!word || CONTROL.test(word) || !PLAIN.test(word)) throw new Error(m().tmux.unsupported);
  return `'${word}'`;
}

/**
 * A single-quoted shell word for a value that may hold spaces or quotes (a folder path). An
 * embedded `'` closes, escapes and reopens the quote; control characters are refused.
 */
export function shellQuote(value: string): string {
  if (!value || CONTROL.test(value)) throw new Error(m().tmux.unsupported);
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Where each agent keeps its conversations, when not in its default home. */
const HOME_VARIABLE = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' } as const;

/**
 * The agent's home as Agent Office sees it, so the new tab resumes from the same place: set to
 * Agent Office's value, or unset (the default home) when Agent Office has none, whatever the
 * login shell exports. The same rule as a tmux launch.
 */
function homeWords(provider: 'claude' | 'codex', env: NodeJS.ProcessEnv): string[] {
  const name = HOME_VARIABLE[provider];
  const value = env[name];
  if (!value) return ['/usr/bin/env', '-u', name].map(shellWord);
  if (!path.isAbsolute(value)) throw new Error(m().tmux.unsupported);
  return [shellWord('/usr/bin/env'), shellQuote(`${name}=${value}`)];
}

function describe(s: OrcaLaunchSession, platform: string, env: NodeJS.ProcessEnv = process.env) {
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
  if (s.executable && !path.isAbsolute(s.executable)) throw Error(m().tmux.unsupported);
  const words = s.fresh
    ? [
        s.executable ? shellQuote(s.executable) : shellWord(s.provider),
        ...(s.skipPermissions
          ? [shellWord(launchArgs({ ...s, fresh: true, initialMessage: undefined })[0])]
          : []),
        ...(s.initialMessage
          ? [shellWord('--'), `'${s.initialMessage.replace(/'/g, `'\\''`)}'`]
          : []),
      ]
    : [s.provider, ...launchArgs({ ...s, fresh: false })].map(shellWord);
  if (
    s.fresh &&
    s.initialMessage &&
    (s.initialMessage.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s.initialMessage))
  )
    throw new Error(m().tmux.invalidMessage);
  const command = [...homeWords(s.provider, env), ...words].join(' ');
  const shown = (s.alias || s.title || '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const name = shown.slice(0, 60) || `${s.provider} ${s.nativeId.slice(0, 8)}`;
  return { cwd: path.resolve(s.cwd), command, name };
}

/** The `orca` arguments for the launch; `--flag=value` so no value can pose as an option. */
export function orcaCreateArgs(
  s: OrcaLaunchSession,
  platform = 'darwin',
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const { cwd, command, name } = describe(s, platform, env);
  return [
    'terminal',
    'create',
    `--worktree=path:${cwd}`,
    `--title=${name}`,
    `--command=${command}`,
    ...(s.background ? [] : ['--focus']),
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
  /** A fresh launch may only target a registered workspace on this Orca host. */
  private async workspace(s: OrcaLaunchSession): Promise<boolean> {
    if (!s.fresh) return true;
    try {
      const result = JSON.parse(
        await this.deps.run(
          this.deps.orca(),
          ['worktree', 'show', `--worktree=path:${s.cwd}`, '--json'],
          { timeout: 5000, env: localOrcaEnv(this.deps.env ?? process.env) },
        ),
      );
      const w = result?.result?.worktree;
      return (
        result?.ok === true &&
        w?.path === path.resolve(s.cwd!) &&
        (w?.identity?.executionHostId ?? w?.hostId) === 'local' &&
        (!w?.hostId || w.hostId === 'local')
      );
    } catch {
      return false;
    }
  }
  /** Orca installed and its runtime answering (`orca status`), checked at most every 5 s. */
  reachable(fresh = false): Promise<boolean> {
    return remember(this, 'orca-status', 5000, fresh, async () => {
      const orca = this.deps.orca();
      if (!path.isAbsolute(orca)) return false;
      try {
        const status = JSON.parse(
          await this.deps.run(orca, ['status', '--json'], {
            timeout: 5000,
            env: localOrcaEnv(this.deps.env ?? process.env),
          }),
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
      const { cwd, command } = describe(s, this.deps.platform, this.deps.env);
      if (
        !(await this.deps.directory(cwd)) ||
        !(await this.reachable()) ||
        !(await this.workspace(s))
      )
        return { available: false };
      return { available: true, command };
    } catch {
      return { available: false };
    }
  }
  /**
   * `duplicate`: the fresh duplicate-launch check (desktop/launch-guard.ts), run before the
   * confirmation and again after it; a conversation already running is never launched.
   */
  start(
    s: OrcaLaunchSession,
    confirm: (
      info: { name: string; cwd: string; command: string },
      duplicate: DuplicateCheck,
    ) => Promise<boolean>,
    authorized?: () => void,
    duplicate?: (fresh: boolean) => Promise<DuplicateCheck>,
  ): Promise<OrcaLaunchInfo> {
    const task = this.queue.then(async () => {
      const t = m().tmux;
      const info = describe(s, this.deps.platform, this.deps.env);
      if (!(await this.deps.directory(info.cwd))) throw new Error(t.folderMissing);
      if (!(await this.reachable(true)) || !(await this.workspace(s)))
        throw new Error(t.orcaUnavailable);
      if (!(await confirmLaunch(duplicate, (check) => confirm(info, check))))
        return { available: true, command: info.command, launched: false };
      if (!(await this.deps.directory(info.cwd))) throw new Error(t.folderMissing);
      if (!(await this.workspace(s))) throw new Error(t.orcaUnavailable);
      let out: string;
      try {
        authorized?.();
        out = await this.deps.run(
          this.deps.orca(),
          orcaCreateArgs(s, this.deps.platform, this.deps.env),
          { timeout: 20000, env: localOrcaEnv(this.deps.env ?? process.env) },
        );
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

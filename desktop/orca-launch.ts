import path from 'node:path';
import { stat } from 'node:fs/promises';
import { remember, runCommand } from '../server/adapters/claude-live.js';
import { m } from '../src/shared/i18n/index.js';
import type { DuplicateCheck, OrcaLaunchInfo, Session } from '../src/shared/types.js';
import { confirmLaunch } from './launch-guard.js';
import { PendingLaunches, type PendingLaunchTarget } from './pending-launch.js';
import { defaultResumeDeps, launchArgs } from './tmux-resume.js';
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
  /**
   * The agent CLI's absolute path, resolved the same way as a tmux launch; it throws when not
   * found, and the tab's login shell then looks the bare name up on its own PATH.
   */
  binary?: (name: string) => Promise<string>;
  /** Waits between looks for a tab whose start Orca did not confirm (tests skip the wait). */
  wait?: (ms: number) => Promise<void>;
  /** Launches that may still start: shared with the duplicate-launch check. */
  pending?: PendingLaunches;
}

/** Orca's worst case is 10 s for the tab plus 10 s for its terminal, after its own CLI start. */
const CREATE_TIMEOUT = 35_000;
/** After an unconfirmed start, look for its terminal every 2 s for about 30 s. */
const ADOPT_EVERY = 2000;
export const ADOPT_LOOKS = 15;

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
  // The resolved CLI, as a tmux launch runs it; without one the tab's login shell looks the
  // agent up on its own PATH, as if the person typed it there.
  if (s.executable && !path.isAbsolute(s.executable)) throw Error(m().tmux.unsupported);
  const agent = s.executable ? shellQuote(s.executable) : shellWord(s.provider);
  const words = s.fresh
    ? [
        agent,
        ...(s.skipPermissions
          ? [shellWord(launchArgs({ ...s, fresh: true, initialMessage: undefined })[0])]
          : []),
        ...(s.initialMessage
          ? [shellWord('--'), `'${s.initialMessage.replace(/'/g, `'\\''`)}'`]
          : []),
      ]
    : [agent, ...launchArgs({ ...s, fresh: false }).map(shellWord)];
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

/**
 * What a `terminal create` answer says about the tab:
 * - `launched`: Orca confirmed the terminal.
 * - `uncertain`: Orca made the tab and queued the command but did not see its terminal in time
 *   (a window behind others or on another Space mounts the tab late), or the call was cut off
 *   before Orca answered. Orca does not cancel that tab: it starts once Orca shows it.
 * - `refused`: Orca said why it made nothing; `workspace` when the reason is the folder itself.
 */
export type OrcaCreateResult =
  | { kind: 'launched' }
  | { kind: 'uncertain' }
  | { kind: 'refused'; reason: string; workspace: boolean };

/** Orca's own "made the tab, its terminal did not appear in time" answers. */
const NOT_YET_STARTED =
  /Timed out waiting for terminal handle|Terminal creation timed out|^runtime_timeout$/i;
/** Refusals that name the folder: no Orca workspace matched it. */
const NOT_A_WORKSPACE = /^(selector_not_found|worktree_not_found|worktree_host_unresolved)$/;

export function classifyOrcaCreate(stdout: string | undefined, error?: unknown): OrcaCreateResult {
  let answer: { ok?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
  try {
    answer = JSON.parse(stdout ?? '') ?? {};
  } catch {
    answer = {};
  }
  if (!error && answer.ok === true) return { kind: 'launched' };
  const e = answer.error;
  const steps = (e?.data as { nextSteps?: unknown } | undefined)?.nextSteps;
  const texts = [e?.code, e?.message, ...(Array.isArray(steps) ? steps : [])].filter(
    (x): x is string => typeof x === 'string',
  );
  if (texts.some((x) => NOT_YET_STARTED.test(x))) return { kind: 'uncertain' };
  // Our own time limit ended the call before Orca answered: whether it made the tab is unknown.
  const cut = error as { killed?: unknown; signal?: unknown; code?: unknown } | undefined;
  if (!e && (cut?.killed === true || !!cut?.signal || cut?.code === 'ETIMEDOUT'))
    return { kind: 'uncertain' };
  return {
    kind: 'refused',
    reason: orcaRefusal(stdout),
    workspace: typeof e?.code === 'string' && NOT_A_WORKSPACE.test(e.code),
  };
}

/**
 * Whether the folder is a registered workspace on this Orca host: `local` yes; `subfolder` when
 * it lies inside one (Orca opens tabs only at a workspace's own folder); `none` when no local
 * workspace holds it; `unknown` when Orca did not answer.
 */
export type WorkspaceCheck =
  { kind: 'local' } | { kind: 'subfolder'; root: string } | { kind: 'none' } | { kind: 'unknown' };

type OrcaWorktree = { path?: unknown; hostId?: unknown; identity?: { executionHostId?: unknown } };
const isLocal = (w: OrcaWorktree) =>
  (w.identity?.executionHostId ?? w.hostId) === 'local' && (!w.hostId || w.hostId === 'local');

/** One Orca terminal as `terminal list` reports it. */
interface OrcaTerminalRow {
  handle: string;
  title?: unknown;
  worktreePath?: unknown;
}

const defaults = (orca: () => string): OrcaLaunchDeps => ({
  run: runCommand,
  orca,
  directory: async (cwd) => (await stat(cwd).catch(() => null))?.isDirectory() ?? false,
  platform: process.platform,
  binary: defaultResumeDeps.binary,
});

export class OrcaLaunch {
  private queue: Promise<unknown> = Promise.resolve();
  private deps: OrcaLaunchDeps;
  /** Launches Orca did not confirm, read by the duplicate-launch check for a while. */
  readonly pending: PendingLaunches;
  constructor(deps: OrcaLaunchDeps | (() => string)) {
    this.deps = typeof deps === 'function' ? defaults(deps) : deps;
    this.pending = this.deps.pending ?? new PendingLaunches();
  }
  private async json(args: string[], timeout = 5000): Promise<Record<string, unknown>> {
    return JSON.parse(
      await this.deps.run(this.deps.orca(), args, {
        timeout,
        env: localOrcaEnv(this.deps.env ?? process.env),
      }),
    );
  }
  /** The registered workspace for the folder: checked for resumes and fresh summons alike. */
  async workspace(s: Pick<OrcaLaunchSession, 'cwd'>): Promise<WorkspaceCheck> {
    const cwd = path.resolve(s.cwd!);
    try {
      const result = await this.json(['worktree', 'show', `--worktree=path:${cwd}`, '--json']);
      const w = (result?.result as { worktree?: OrcaWorktree } | undefined)?.worktree;
      if (result?.ok === true && w)
        return w.path === cwd && isLocal(w) ? { kind: 'local' } : { kind: 'none' };
    } catch {
      /* Not a workspace of its own, or Orca did not answer: the list below tells which. */
    }
    try {
      const result = await this.json(['worktree', 'list', '--limit=10000', '--json']);
      const rows = (result?.result as { worktrees?: unknown } | undefined)?.worktrees;
      if (result?.ok !== true || !Array.isArray(rows)) return { kind: 'unknown' };
      let root = '';
      for (const w of rows as OrcaWorktree[]) {
        if (typeof w?.path !== 'string' || !path.isAbsolute(w.path) || !isLocal(w)) continue;
        const folder = path.resolve(w.path);
        // Its own folder that `worktree show` did not confirm: Orca could not tell, nor can we.
        if (folder === cwd) return { kind: 'unknown' };
        if (cwd.startsWith(folder + path.sep) && folder.length > root.length) root = folder;
      }
      return root ? { kind: 'subfolder', root } : { kind: 'none' };
    } catch {
      return { kind: 'unknown' };
    }
  }
  /** Why the folder cannot take a new Orca tab; `''` when it can. */
  private async workspaceRefusal(s: OrcaLaunchSession): Promise<string> {
    const t = m().tmux;
    const check = await this.workspace(s);
    if (check.kind === 'local') return '';
    if (check.kind === 'subfolder') return t.orcaSubfolder(check.root);
    if (check.kind === 'none') return t.orcaNotWorkspace;
    return t.orcaUnavailable;
  }
  /** Orca installed and its runtime answering (`orca status`), checked at most every 5 s. */
  reachable(fresh = false): Promise<boolean> {
    return remember(this, 'orca-status', 5000, fresh, async () => {
      if (!path.isAbsolute(this.deps.orca())) return false;
      try {
        const status = await this.json(['status', '--json']);
        return (
          status?.ok === true &&
          (status.result as { runtime?: { reachable?: unknown } } | undefined)?.runtime
            ?.reachable === true
        );
      } catch {
        return false;
      }
    });
  }
  /** Brings Orca to the front, where it mounts the tab it shows (and so starts its command). */
  async reveal(): Promise<void> {
    if (this.deps.platform !== 'darwin') return;
    await this.deps.run('/usr/bin/open', ['-a', 'Orca'], { timeout: 5000 }).catch(() => '');
  }
  /**
   * The agent CLI resolved as for tmux. Orca still recognizes an interactive agent by the file
   * name of the command's program (`claude`, `codex`), so only such a path is used; otherwise
   * the tab's login shell finds the agent on its own PATH, as before.
   */
  private async resolved(s: OrcaLaunchSession): Promise<OrcaLaunchSession> {
    if (s.executable || !this.deps.binary) return s;
    try {
      const executable = await this.deps.binary(s.provider);
      return path.isAbsolute(executable) && path.basename(executable) === s.provider
        ? { ...s, executable }
        : s;
    } catch {
      return s;
    }
  }
  /** The worktree's terminals now; `complete` only when Orca listed every one of them. */
  private async terminals(cwd: string) {
    try {
      const result = await this.json(['terminal', 'list', `--worktree=path:${cwd}`, '--json']);
      const list = (result?.result ?? {}) as { terminals?: unknown; truncated?: unknown };
      const rows = (Array.isArray(list.terminals) ? list.terminals : []).filter(
        (t): t is OrcaTerminalRow =>
          typeof t?.handle === 'string' &&
          (typeof t.worktreePath !== 'string' ||
            !t.worktreePath ||
            path.resolve(t.worktreePath) === cwd),
      );
      return {
        rows,
        complete: result?.ok === true && Array.isArray(list.terminals) && list.truncated !== true,
      };
    } catch {
      return { rows: [] as OrcaTerminalRow[], complete: false };
    }
  }
  /**
   * The terminal of a tab whose start Orca did not confirm: a handle of the same worktree that
   * the list taken before creating it did not have (so that list must be whole), titled as the
   * launch. Only the title ties a terminal to this launch: a new untitled one may be any tab the
   * person opened meanwhile, so it is never adopted and the start stays unconfirmed.
   */
  private async adopt(
    info: { cwd: string; name: string },
    before: { handles: Set<string>; complete: boolean },
  ): Promise<string | undefined> {
    // A terminal missing from a cut-short earlier list is not new: titles repeat (reopening the
    // same conversation), so nothing is adopted without a whole baseline.
    if (!before.complete) return undefined;
    const wait = this.deps.wait ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
    for (let look = 0; look < ADOPT_LOOKS; look++) {
      await wait(ADOPT_EVERY);
      const titled = (await this.terminals(info.cwd)).rows.find(
        (t) => !before.handles.has(t.handle) && t.title === info.name,
      );
      if (titled) return titled.handle;
    }
    return undefined;
  }
  /** Read-only: whether the action can be offered, and the command it would type. */
  async status(s: OrcaLaunchSession): Promise<OrcaLaunchInfo> {
    try {
      const session = await this.resolved(s);
      const { cwd, command } = describe(session, this.deps.platform, this.deps.env);
      if (!(await this.deps.directory(cwd)) || !(await this.reachable()))
        return { available: false };
      const check = await this.workspace(session);
      const t = m().tmux;
      if (check.kind === 'subfolder')
        return { available: false, reason: t.orcaSubfolder(check.root) };
      if (check.kind === 'none') return { available: false, reason: t.orcaNotWorkspace };
      if (check.kind !== 'local') return { available: false };
      return { available: true, command };
    } catch {
      return { available: false };
    }
  }
  /**
   * `duplicate`: the fresh duplicate-launch check (desktop/launch-guard.ts), run before the
   * confirmation and again after it; a conversation already running is never launched.
   * A start Orca did not confirm is looked for (`adopt`); still unseen, it is answered as
   * `uncertain` and kept in `pending`, never as a refusal: its tab starts once Orca shows it.
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
      const session = await this.resolved(s);
      const info = describe(session, this.deps.platform, this.deps.env);
      // A fresh summon is known by its agent, folder and name (its tmux summon is the same one).
      const target: PendingLaunchTarget = { ...session, name: session.alias ?? '' };
      if (!(await this.deps.directory(info.cwd))) throw new Error(t.folderMissing);
      if (!(await this.reachable(true))) throw new Error(t.orcaUnavailable);
      const refusal = await this.workspaceRefusal(session);
      if (refusal) throw new Error(refusal);
      if (!(await confirmLaunch(duplicate, (check) => confirm(info, check))))
        return { available: true, command: info.command, launched: false };
      if (!(await this.deps.directory(info.cwd))) throw new Error(t.folderMissing);
      const changed = await this.workspaceRefusal(session);
      if (changed) throw new Error(changed);
      const before = await this.terminals(info.cwd);
      // Last moment before create: the listing above may take seconds while access is revoked.
      authorized?.();
      let out: string | undefined;
      let failure: unknown;
      try {
        out = await this.deps.run(
          this.deps.orca(),
          orcaCreateArgs(session, this.deps.platform, this.deps.env),
          { timeout: CREATE_TIMEOUT, env: localOrcaEnv(this.deps.env ?? process.env) },
        );
      } catch (error) {
        failure = error ?? new Error('failed');
        out = (error as { stdout?: string } | undefined)?.stdout;
      }
      const result = classifyOrcaCreate(out, failure);
      if (result.kind === 'refused')
        throw new Error(t.orcaRefused(result.reason, result.workspace));
      const launched = {
        available: true,
        command: info.command,
        launched: true,
        message: t.orcaLaunched,
      };
      if (result.kind === 'launched') {
        this.pending.clear(target);
        return launched;
      }
      // Guard against a second start of this conversation while the tab is looked for.
      this.pending.add(target);
      // The person asked for this tab: Orca in front mounts it, which starts its command. A
      // background (remote) launch answers at once: its caller's request has its own deadline.
      if (!session.background) await this.reveal();
      const handle = session.background
        ? undefined
        : await this.adopt(info, {
            handles: new Set(before.rows.map((row) => row.handle)),
            complete: before.complete,
          });
      if (handle) {
        this.pending.clear(target);
        await this.deps
          .run(this.deps.orca(), ['terminal', 'switch', `--terminal=${handle}`, '--json'], {
            timeout: 8000,
            env: localOrcaEnv(this.deps.env ?? process.env),
          })
          .catch(() => '');
        return launched;
      }
      // Still unseen: the guard runs its full window from now.
      this.pending.add(target);
      return {
        available: true,
        command: info.command,
        launched: false,
        uncertain: true,
        message: t.orcaUncertain,
      };
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}

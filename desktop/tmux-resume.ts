import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../server/adapters/claude-live.js';
import { m } from '../src/shared/i18n/index.js';
import { tmuxArg, type TerminalHost } from './terminal-host.js';
import type { DuplicateCheck, Session, TmuxResumeInfo } from '../src/shared/types.js';
import { agentWords, chooseSessionId, NATIVE_ID } from './launch/agents.js';
import {
  launchQueue,
  runLaunch,
  startOrThrow,
  type Destination,
  type DestinationProbe,
  type DestinationStart,
  type LaunchQueue,
  type StartContext,
} from './launch/pipeline.js';

const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
/** A session of our dedicated server with its ownership options (cwd and alias decoded). */
interface OwnedRow {
  name: string;
  token: string;
  native: string;
  cwd: string;
  alias: string;
}
export type SavedSession = Pick<Session, 'provider' | 'nativeId' | 'cwd'> & {
  /** A new conversation: a named slot of its folder, agent and name. */
  fresh?: boolean;
  /**
   * A fork of `nativeId`: a new conversation branched off it. It takes the same named slot as
   * a summon of that name (so it is listed, tagged and resumed like one), never the original's.
   */
  fork?: boolean;
  /** Launch without the agent's permission prompts (the person's `tmuxSkipPermissions`). */
  skipPermissions?: boolean;
  agentName?: string;
  initialMessage?: string;
  /** A new conversation's id, chosen before launch where the agent allows it. */
  sessionId?: string;
};
/** A new conversation in a named slot (a summon or a fork), as opposed to a resume. */
const inSlot = (s: Pick<SavedSession, 'fresh' | 'fork'>) => !!(s.fresh || s.fork);
const kindOf = (s: Pick<SavedSession, 'fresh' | 'fork'>) =>
  s.fork ? ('fork' as const) : s.fresh ? ('new' as const) : ('resume' as const);
/**
 * The agent's arguments for this session, as tmux gets them (desktop/launch/agents.ts decides
 * them). tmux treats a trailing semicolon as a command separator even in a separate argv: it is
 * escaped for tmux only; execvp still receives the original literal prompt.
 */
export function launchArgs(s: SavedSession): string[] {
  const words = agentWords({ ...s, kind: kindOf(s) });
  return [...words.args, ...(words.message !== undefined ? ['--', tmuxArg(words.message)] : [])];
}
/** What a tmux session runs (`@agent_office_native`): `<provider>:<conversation id>`. */
const nativeTag = (provider: string, nativeId: string) => `${provider}:${nativeId}`;
const ALIAS = /^[\p{L}\p{N} _-]{1,40}$/u;
const decode = (value: string | undefined) => Buffer.from(value ?? '', 'base64').toString('utf8');
/** One reconnectable fresh conversation slot per project and provider. */
export function summonSession(
  cwd: string,
  provider: 'claude' | 'codex',
  name?: string,
  initialMessage = '',
): SavedSession {
  const agentName = name?.trim().normalize('NFC');
  if (name !== undefined && (!agentName || !/^[\p{L}\p{N} _-]{1,40}$/u.test(agentName)))
    throw new Error(m().tmux.invalidName);
  if (
    typeof initialMessage !== 'string' ||
    initialMessage.length > 4000 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(initialMessage)
  )
    throw new Error(m().tmux.invalidMessage);
  return {
    cwd,
    provider,
    nativeId: 'new',
    fresh: true,
    agentName,
    initialMessage: initialMessage.trim() ? initialMessage : undefined,
  };
}
export interface ResumeDeps {
  run: typeof runCommand;
  binary: (name: string) => Promise<string>;
  directory: (cwd: string) => Promise<boolean>;
  platform: string;
  server: string;
  /** The launch queue (desktop/launch/pipeline.ts); the app's own one when left out. */
  queue?: LaunchQueue;
}
export const defaultResumeDeps: ResumeDeps = {
  run: runCommand,
  async binary(name) {
    const dirs = [
      path.join(os.homedir(), '.local/bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      ...(process.env.PATH ?? '').split(path.delimiter),
      '/usr/bin',
      '/bin',
    ];
    for (const dir of dirs.filter((x) => path.isAbsolute(x))) {
      const file = path.join(dir, name);
      try {
        await access(file, constants.X_OK);
        if ((await stat(file)).isFile()) return file;
      } catch {}
    }
    throw new Error(m().tmux.missing);
  },
  directory: async (cwd) => (await stat(cwd).catch(() => null))?.isDirectory() ?? false,
  platform: process.platform,
  server: 'agent-office',
};
/** Dedicated server and exact targets: never reuses an arbitrary user pane or injects input. */
/** What a probe carries to the start: the inspection right before it. */
export type TmuxInspection = Awaited<ReturnType<TmuxResume['inspect']>>;
export class TmuxResume {
  constructor(private deps: ResumeDeps = defaultResumeDeps) {}
  private describe(s: SavedSession) {
    if (
      !['darwin', 'linux'].includes(this.deps.platform) ||
      !['claude', 'codex'].includes(s.provider) ||
      !NATIVE_ID.test(s.nativeId)
    )
      throw new Error(m().tmux.unsupported);
    if (!s.cwd || !path.isAbsolute(s.cwd) || /[\x00-\x1f\x7f]/.test(s.cwd))
      throw new Error(m().tmux.folderMissing);
    const token = createHash('sha256')
      .update(
        inSlot(s)
          ? `new:${s.provider}:${path.resolve(s.cwd)}${s.agentName ? ':' + s.agentName : ''}`
          : `${s.provider}:${s.nativeId}`,
      )
      .digest('hex');
    const name = s.agentName
      ? `${s.agentName.replace(/ /g, '-')}-${s.provider}-${token.slice(0, 8)}`
      : `office-${s.provider}-${token.slice(0, 16)}`;
    return { token, name, cwd: s.cwd };
  }
  /** Our dedicated server's sessions. A missing server is an empty list; other failures refuse. */
  private async sessions(tmux: string): Promise<OwnedRow[]> {
    let rows: string;
    try {
      rows = await this.deps.run(tmux, [
        '-L',
        this.deps.server,
        'list-sessions',
        '-F',
        '#{session_name}\t#{@agent_office_resume}\t#{@agent_office_native}\t#{@agent_office_cwd}\t#{@agent_office_alias}',
      ]);
    } catch (error) {
      const e = error as Error & { stderr?: string };
      if (
        !/no server running|No such file or directory|error connecting.*No such file/i.test(
          `${e.message}\n${e.stderr ?? ''}`,
        )
      )
        throw new Error(m().tmux.failed);
      rows = '';
    }
    return rows
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, token, native, cwd, alias] = line.split('\t');
        return {
          name,
          token: token ?? '',
          native: native ?? '',
          cwd: decode(cwd),
          alias: decode(alias),
        };
      });
  }
  /** One of our summons: its name and token are exactly what its folder, agent and name give. */
  private summoned(row: OwnedRow, provider: 'claude' | 'codex') {
    if (!path.isAbsolute(row.cwd) || !ALIAS.test(row.alias)) return false;
    try {
      const expected = this.describe(summonSession(row.cwd, provider, row.alias));
      return expected.name === row.name && expected.token === row.token;
    } catch {
      return false;
    }
  }
  /** The single dead pane to respawn, `undefined` while one runs. */
  private async deadPaneOf(tmux: string, name: string): Promise<string | undefined> {
    const panes = (
      await this.deps.run(tmux, [
        '-L',
        this.deps.server,
        'list-panes',
        '-s',
        '-t',
        name,
        '-F',
        '#{pane_id}\t#{pane_dead}',
      ])
    )
      .trim()
      .split('\n')
      .map((line) => line.split('\t'));
    if (
      !panes.length ||
      panes.some(([id, dead]) => !/^%\d+$/.test(id) || !['0', '1'].includes(dead))
    )
      throw new Error(m().tmux.failed);
    if (panes.every(([, dead]) => dead === '1')) {
      if (panes.length !== 1) throw new Error(m().tmux.ended);
      return panes[0][0];
    }
    return undefined;
  }
  async inspect(s: SavedSession) {
    const data = this.describe(s);
    const tmux = await this.deps.binary('tmux');
    const rows = await this.sessions(tmux);
    const own = rows.find((row) => row.name === data.name);
    if (own && own.token !== data.token) throw new Error(m().tmux.conflict);
    // A summoned conversation stays in its summon's session after it has an id: tagged there at
    // launch (Claude `--session-id`) or once its live screen was verified on that pane (`adopt`).
    const tag = nativeTag(s.provider, s.nativeId);
    const tagged = inSlot(s)
      ? []
      : rows.filter(
          (row) =>
            row !== own &&
            row.native === tag &&
            this.summoned(row, s.provider as 'claude' | 'codex'),
        );
    const found: { row: OwnedRow; deadPane?: string }[] = [];
    if (own) found.push({ row: own, deadPane: await this.deadPaneOf(tmux, own.name) });
    for (const row of tagged) {
      try {
        found.push({ row, deadPane: await this.deadPaneOf(tmux, row.name) });
      } catch {
        /* A summon that cannot be resumed in place is not this conversation's session. */
      }
    }
    // A live one first; otherwise the exact resume name, then a tagged summon to respawn.
    const pick = found.find((x) => !x.deadPane) ?? found[0];
    const name = pick?.row.name ?? data.name;
    const info: TmuxResumeInfo = {
      name,
      cwd: data.cwd,
      running: !!pick && !pick.deadPane,
      command: `${quote(tmux)} -L ${quote(this.deps.server)} attach-session -t ${quote(tmuxArg('=' + name))}`,
      canOpen: this.deps.platform === 'darwin',
    };
    return {
      name,
      token: pick?.row.token ?? data.token,
      // A summon resumed in place keeps the name it was summoned with.
      alias: pick && pick.row !== own ? pick.row.alias : (s.agentName ?? ''),
      cwd: data.cwd,
      tmux,
      info,
      deadPane: pick?.deadPane,
    };
  }
  async status(s: SavedSession) {
    return (await this.inspect(s)).info;
  }
  /**
   * This conversation's own session, when it runs: `at` is its server's socket path and live
   * panes (null when they could not be listed), so a verified agent terminal can be matched
   * to it (desktop/launch-guard.ts). Null when it does not run.
   */
  async ownPanes(
    s: SavedSession,
  ): Promise<{ at: { socket: string; panes: string[] } | null } | null> {
    const current = await this.inspect(s);
    if (!current.info.running) return null;
    try {
      const rows = (
        await this.deps.run(current.tmux, [
          '-L',
          this.deps.server,
          'list-panes',
          '-s',
          '-t',
          current.name,
          '-F',
          '#{socket_path}\t#{pane_id}\t#{pane_dead}',
        ])
      )
        .trim()
        .split('\n')
        .map((line) => line.split('\t'));
      const socket = rows[0]?.[0] ?? '';
      const panes = rows
        .filter(([path, id, dead]) => path === socket && /^%\d+$/.test(id ?? '') && dead === '0')
        .map(([, id]) => id);
      return { at: socket && panes.length ? { socket, panes } : null };
    } catch {
      return { at: null };
    }
  }
  /**
   * Read-only, for the launch pipeline (desktop/launch/pipeline.ts): `running` when this
   * launch's own session already runs (nothing new starts), otherwise whether it can start.
   */
  async probe(s: SavedSession): Promise<DestinationProbe<TmuxInspection>> {
    try {
      const current = await this.inspect(s);
      const { info } = current;
      if (info.running)
        return { available: true, running: true, command: info.command, detail: current };
      if (!(await this.deps.directory(current.cwd)))
        return { available: false, reason: m().tmux.folderMissing, detail: current };
      await this.deps.binary(s.provider);
      return { available: true, command: info.command, detail: current };
    } catch (error) {
      return { available: false, reason: (error as Error).message };
    }
  }
  /**
   * Starts the agent in this launch's session, after the pipeline's confirmation, from the
   * inspection its probe just took: a dead pane of it is respawned, otherwise a new session.
   */
  async launch(
    s: SavedSession,
    context: Pick<StartContext<TmuxInspection>, 'probe' | 'authorized'>,
  ): Promise<DestinationStart<TmuxResumeInfo>> {
    const current = context.probe.detail ?? (await this.inspect(s));
    const binary = await this.deps.binary(s.provider);
    // A new conversation's id where the agent takes one, recorded with the session so the
    // conversation still finds this session once the office knows it by that id.
    const sessionId = inSlot(s)
      ? (s.sessionId ?? chooseSessionId({ kind: kindOf(s), provider: s.provider }))
      : undefined;
    const args = launchArgs({ ...s, sessionId });
    const native = inSlot(s)
      ? sessionId
        ? nativeTag(s.provider, sessionId)
        : ''
      : nativeTag(s.provider, s.nativeId);
    // Multiple command arguments use tmux execvp, not its shell-command parser.
    // Set the ownership marker in the same tmux command queue as session creation.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [
        path.dirname(binary),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        process.env.PATH ?? '/usr/bin:/bin',
      ].join(path.delimiter),
    };
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.CLAUDECODE;
    // The last moment before anything starts: a revoked permission keeps its own message.
    context.authorized?.();
    try {
      await this.deps.run(
        current.tmux,
        [
          '-L',
          this.deps.server,
          '-f',
          '/dev/null',
          ...(current.deadPane
            ? ['respawn-pane', '-t', current.deadPane, '-c', current.cwd]
            : // Detached, a new window would be 80×24: Claude Code's box then shows 7 rows
              // and a longer draft hides its start. A client that attaches still resizes it.
              [
                'new-session',
                '-d',
                '-x',
                '200',
                '-y',
                '50',
                '-s',
                current.name,
                '-c',
                current.cwd,
              ]),
          '/usr/bin/env',
          '-u',
          'CLAUDECODE',
          '-u',
          'CODEX_HOME',
          '-u',
          'CLAUDE_CONFIG_DIR',
          `PATH=${env.PATH}`,
          ...['CODEX_HOME', 'CLAUDE_CONFIG_DIR'].flatMap((key) =>
            env[key] ? [`${key}=${env[key]}`] : [],
          ),
          binary,
          ...args,
          ';',
          'set-option',
          '-t',
          current.name,
          '@agent_office_cwd',
          Buffer.from(current.cwd).toString('base64'),
          ';',
          'set-option',
          '-t',
          current.name,
          '@agent_office_alias',
          Buffer.from(current.alias).toString('base64'),
          ';',
          'set-option',
          '-t',
          current.name,
          '@agent_office_native',
          native,
          ';',
          'set-option',
          '-t',
          current.name,
          '@agent_office_claimed',
          '',
          ';',
          'set-option',
          '-t',
          current.name,
          '@agent_office_resume',
          current.token,
        ],
        { env },
      );
    } catch (error) {
      // tmux may have made the session before it failed or our time limit cut it off: look
      // before answering. Started: it is launched. Cut off, or not readable now: it may still
      // appear, so it is `uncertain` (held pending), never a refusal to retry. Only a failure
      // tmux answered while its session list shows nothing is `failed`.
      const after = await this.inspect(s).catch(() => null);
      if (after?.info.running) return { state: 'launched', detail: after.info };
      const cut = error as { killed?: unknown; signal?: unknown; code?: unknown } | undefined;
      if (!after || cut?.killed === true || !!cut?.signal || cut?.code === 'ETIMEDOUT')
        return { state: 'uncertain', message: m().launch.tmuxUncertain };
      throw new Error(m().tmux.failed);
    }
    // tmux took it. A session gone (or a dead pane) right after means the agent itself exited,
    // often at a login or folder-trust prompt never finished, not a broken install. A look that
    // fails proves nothing either way: the agent may be running, so `uncertain`, not refused.
    const result = await this.inspect(s).catch(() => null);
    if (!result) return { state: 'uncertain', message: m().launch.tmuxUncertain };
    if (!result.info.running) throw new Error(m().tmux.exitedAtStart);
    return { state: 'launched', detail: result.info };
  }
  /** tmux as a launch destination of this session alone (the older entry points, tests). */
  private destination(): Destination<SavedSession, TmuxInspection, TmuxResumeInfo> {
    return {
      id: 'tmux',
      launches: true,
      place: 'tmux',
      probe: (s) => this.probe(s),
      start: (s, context) => this.launch(s, context),
    };
  }
  /**
   * The launch pipeline (desktop/launch/pipeline.ts) for this one destination. `duplicate`:
   * for a resume, the fresh duplicate-launch check (desktop/launch-guard.ts), run before the
   * confirmation and again after it; a conversation already running elsewhere is never
   * launched. A summon (a new conversation) has none. A refusal throws its reason.
   */
  async start(
    s: SavedSession,
    confirm: (info: TmuxResumeInfo, duplicate: DuplicateCheck) => Promise<boolean>,
    authorized?: () => void,
    duplicate?: (fresh: boolean) => Promise<DuplicateCheck>,
  ): Promise<TmuxResumeInfo> {
    const result = await startOrThrow(
      runLaunch(this.destination(), s, {
        queue: this.deps.queue ?? launchQueue,
        check: duplicate,
        confirm: (probe, check) => confirm(probe.detail!.info, check),
        authorized,
      }),
    );
    // Not seen to start, maybe started: told as such, never as a start to try again.
    if (result.state === 'uncertain') throw new Error(result.message);
    return ('detail' in result && result.detail) || result.probe.detail!.info;
  }
  async connections(cwd: string): Promise<NonNullable<TmuxResumeInfo['connections']>> {
    const tmux = await this.deps.binary('tmux');
    let rows: string;
    try {
      rows = await this.deps.run(tmux, [
        '-L',
        this.deps.server,
        'list-sessions',
        '-F',
        '#{session_name}\t#{@agent_office_resume}\t#{@agent_office_cwd}\t#{@agent_office_alias}',
      ]);
    } catch (error) {
      const e = error as Error & { stderr?: string };
      if (/no server running|No such file or directory/i.test(`${e.message} ${e.stderr ?? ''}`))
        return [];
      throw error;
    }
    const result: NonNullable<TmuxResumeInfo['connections']> = [];
    for (const line of rows.split('\n')) {
      const [name, token, encodedCwd, encodedAlias] = line.split('\t');
      const folder = Buffer.from(encodedCwd ?? '', 'base64').toString('utf8');
      if (!path.isAbsolute(folder) || path.resolve(folder) !== path.resolve(cwd)) continue;
      const provider = /-(claude|codex)-[a-f0-9]{8}$/.exec(name)?.[1] as
        'claude' | 'codex' | undefined;
      const alias = Buffer.from(encodedAlias ?? '', 'base64').toString('utf8');
      if (!provider || !/^[\p{L}\p{N} _-]{1,40}$/u.test(alias)) continue;
      const saved = summonSession(folder, provider, alias);
      const expected = this.describe(saved);
      if (expected.name !== name || expected.token !== token) continue;
      const info = await this.status(saved);
      if (info.running) result.push({ name: alias, label: name, command: info.command });
    }
    return result;
  }
  async namedFolders(): Promise<Set<string>> {
    if (!['darwin', 'linux'].includes(this.deps.platform)) return new Set();
    try {
      const rows = await this.deps.run(await this.deps.binary('tmux'), [
        '-L',
        this.deps.server,
        'list-sessions',
        '-F',
        '#{@agent_office_cwd}\t#{@agent_office_alias}',
      ]);
      return new Set(
        rows.split('\n').flatMap((line) => {
          const [cwd, alias] = line.split('\t');
          const folder = Buffer.from(cwd ?? '', 'base64').toString('utf8');
          return alias && path.isAbsolute(folder) ? [path.resolve(folder)] : [];
        }),
      );
    } catch {
      return new Set();
    }
  }
  /**
   * Records which conversation a summoned session runs (`@agent_office_native`), after the
   * caller verified that conversation's live process on this exact pane (its terminal lookup).
   * Only a pane of our dedicated server whose session is exactly one of our summons is tagged.
   * Covers Codex (no id at launch), Claude after `/clear`, and summons made before the tag.
   * `true` once the session carries the tag.
   */
  async adopt(host: TerminalHost, provider: 'claude' | 'codex', nativeId: string) {
    if (host.kind !== 'tmux' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(nativeId)) return false;
    const tmux = await this.deps.binary('tmux');
    const [socket, name, token, native, cwd, alias] = (
      await this.deps.run(tmux, [
        '-L',
        this.deps.server,
        'display-message',
        '-p',
        '-t',
        host.pane,
        '#{socket_path}\t#{session_name}\t#{@agent_office_resume}\t#{@agent_office_native}\t#{@agent_office_cwd}\t#{@agent_office_alias}',
      ])
    )
      .replace(/\r?\n$/, '')
      .split('\t');
    if (socket !== host.socket || !name) return false;
    const row = {
      name,
      token: token ?? '',
      native: native ?? '',
      cwd: decode(cwd),
      alias: decode(alias),
    };
    if (!this.summoned(row, provider)) return false;
    const tag = nativeTag(provider, nativeId);
    if (row.native === tag) return true;
    await this.deps.run(tmux, [
      '-L',
      this.deps.server,
      'set-option',
      '-t',
      host.pane,
      '@agent_office_native',
      tag,
    ]);
    return true;
  }
  /** Only names from our dedicated server and the exact discovered pane may be adopted. */
  async aliasFor(host: TerminalHost, id: string): Promise<string | null> {
    if (host.kind !== 'tmux') return null;
    const tmux = await this.deps.binary('tmux');
    const row = (
      await this.deps.run(tmux, [
        '-L',
        this.deps.server,
        'display-message',
        '-p',
        '-t',
        host.pane,
        '#{socket_path}\t#{@agent_office_resume}\t#{@agent_office_alias}\t#{@agent_office_claimed}',
      ])
    )
      .trim()
      .split('\t');
    if (row[0] !== host.socket || !/^[a-f0-9]{64}$/.test(row[1] ?? '') || row[3] === id)
      return null;
    const alias = Buffer.from(row[2] ?? '', 'base64').toString('utf8');
    if (!/^[\p{L}\p{N} _-]{1,40}$/u.test(alias)) return null;
    return alias;
  }
  async claimAlias(host: TerminalHost, id: string) {
    if (host.kind !== 'tmux' || !(await this.aliasFor(host, id))) return;
    await this.deps.run(await this.deps.binary('tmux'), [
      '-L',
      this.deps.server,
      'set-option',
      '-p',
      '-t',
      host.pane,
      '@agent_office_claimed',
      id,
    ]);
  }
  async open(s: SavedSession) {
    const { info } = await this.inspect(s);
    if (!info.running) throw new Error(m().tmux.ended);
    if (!info.canOpen) throw new Error(m().tmux.openFailed);
    try {
      await this.deps.run('/usr/bin/osascript', [
        '-e',
        'on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run',
        info.command,
      ]);
    } catch {
      throw new Error(m().tmux.openFailed);
    }
    return info;
  }
}

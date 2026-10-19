import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../server/adapters/claude-live.js';
import { m } from '../src/shared/i18n/index.js';
import type { Session, TmuxResumeInfo } from '../src/shared/types.js';

const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
type SavedSession = Pick<Session, 'provider' | 'nativeId' | 'cwd'>;
export interface ResumeDeps {
  run: typeof runCommand;
  binary: (name: string) => Promise<string>;
  directory: (cwd: string) => Promise<boolean>;
  platform: string;
  server: string;
}
const defaults: ResumeDeps = {
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
export class TmuxResume {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private deps: ResumeDeps = defaults) {}
  private describe(s: SavedSession) {
    if (
      !['darwin', 'linux'].includes(this.deps.platform) ||
      !['claude', 'codex'].includes(s.provider) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(s.nativeId)
    )
      throw new Error(m().tmux.unsupported);
    if (!s.cwd || !path.isAbsolute(s.cwd) || /[\x00-\x1f\x7f]/.test(s.cwd))
      throw new Error(m().tmux.folderMissing);
    const token = createHash('sha256').update(`${s.provider}:${s.nativeId}`).digest('hex');
    const name = `office-${s.provider}-${token.slice(0, 16)}`;
    return { token, name, cwd: s.cwd };
  }
  private async inspect(s: SavedSession) {
    const data = this.describe(s);
    const tmux = await this.deps.binary('tmux');
    // A missing server is expected; other failures must not be interpreted as permission to start.
    let rows: string;
    try {
      rows = await this.deps.run(tmux, [
        '-L',
        this.deps.server,
        'list-sessions',
        '-F',
        '#{session_name}\t#{@agent_office_resume}',
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
    const row = rows
      .split('\n')
      .map((x) => x.split('\t'))
      .find(([name]) => name === data.name);
    if (row && row[1] !== data.token) throw new Error(m().tmux.conflict);
    let deadPane: string | undefined;
    if (row) {
      const panes = (
        await this.deps.run(tmux, [
          '-L',
          this.deps.server,
          'list-panes',
          '-s',
          '-t',
          data.name,
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
        deadPane = panes[0][0];
      }
    }
    const info: TmuxResumeInfo = {
      name: data.name,
      cwd: data.cwd,
      running: !!row && !deadPane,
      command: `${quote(tmux)} -L ${quote(this.deps.server)} attach-session -t ${quote('=' + data.name)}`,
      canOpen: this.deps.platform === 'darwin',
    };
    return { ...data, tmux, info, deadPane };
  }
  async status(s: SavedSession) {
    return (await this.inspect(s)).info;
  }
  start(s: SavedSession, confirm: (info: TmuxResumeInfo) => Promise<boolean>) {
    const task = this.queue.then(async () => {
      let current = await this.inspect(s);
      if (current.info.running) return current.info;
      if (!(await this.deps.directory(current.cwd))) throw new Error(m().tmux.folderMissing);
      const binary = await this.deps.binary(s.provider);
      if (!(await confirm(current.info))) return current.info;
      current = await this.inspect(s);
      if (current.info.running) return current.info;
      if (!(await this.deps.directory(current.cwd))) throw new Error(m().tmux.folderMissing);
      const args = s.provider === 'claude' ? ['--resume', s.nativeId] : ['resume', s.nativeId];
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
              : ['new-session', '-d', '-s', current.name, '-c', current.cwd]),
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
            '@agent_office_resume',
            current.token,
          ],
          { env },
        );
        const result = await this.inspect(s);
        if (!result.info.running) throw new Error(m().tmux.ended);
        return result.info;
      } catch {
        throw new Error(m().tmux.failed);
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
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

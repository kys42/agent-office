import { forget, remember } from '../server/adapters/claude-live.js';
import { m } from '../src/shared/i18n/index.js';
import { hostPlaceName } from '../src/shared/launch.js';
import type { HostApp, JumpResult, LaunchPlace, RunningHost } from '../src/shared/types.js';
import {
  focusHost,
  focusTtyTab,
  inspectProcess,
  isOrca,
  isTmux,
  orcaTerminals,
  ptyOwner,
  TerminalFocusError,
  type ProcessEnv,
  type ProcessView,
  type TerminalHost,
  type TerminalHostDeps,
} from './terminal-host.js';

/**
 * Where a running agent is when no terminal tab of it could be verified (#376): the app read
 * from its process's parents, and how to bring that place forward. Navigation only: nothing
 * here ever types. Agent-neutral: each agent's liveness adapter (desktop/launch-guard.ts)
 * names the process, this module reads where it is.
 */

/** How the main process brings a running place forward. Never leaves the main process. */
export type HostWay =
  /** A verified terminal (the tab or pane of the window that parked it). */
  | { kind: 'terminal'; host: TerminalHost }
  /** An Orca terminal, not verified: the one its process was started in, when its env names it. */
  | { kind: 'orca'; handle?: string }
  /** The tmux pane its environment names, not verified. */
  | { kind: 'tmux'; socket: string; pane: string }
  /** A macOS app (`name`: its bundle's own name); Terminal and iTerm2 select the tab on `tty`. */
  | { kind: 'app'; bundle: string; name: string; tty?: string }
  /** A background session no window shows: its attach command, to copy. */
  | { kind: 'attach'; command: string }
  | { kind: 'none' };

export interface HostPlace {
  /** The coarse place, as the duplicate check names it (a fork's default destination). */
  where: LaunchPlace;
  /** What a window may know. */
  host: RunningHost;
  way: HostWay;
}

export const NOWHERE: HostPlace = {
  where: 'other',
  host: { app: 'unknown' },
  way: { kind: 'none' },
};

interface Row {
  ppid: number;
  tty: string;
  command: string;
}

/** `ps -axo pid=,ppid=,tty=,comm=` by pid. */
export function processRows(table: string): Map<number, Row> {
  const rows = new Map<number, Row>();
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), tty: m[3], command: m[4].trim() });
  }
  return rows;
}

/**
 * The outermost `.app` bundle of the first process, from `pid` up through its parents, that
 * runs from one (a helper nested in the app, `Orca Helper.app`, belongs to the outer app).
 */
export function ancestorBundle(rows: Map<number, Row>, pid: number): string | null {
  let current = rows.get(pid);
  for (let depth = 0; current && depth < 32; depth++) {
    if (/\.app\/Contents\/MacOS\//.test(current.command)) {
      const bundle = /^(\/.*?\.app)\//.exec(current.command)?.[1];
      if (bundle) return bundle;
    }
    if (current.ppid <= 1) return null;
    current = rows.get(current.ppid);
  }
  return null;
}

/** Apps known by their bundle's own name; any other is `app`, named as it is. */
const BUNDLES: [RegExp, Exclude<HostApp, 'app'>][] = [
  [/^Orca$/, 'orca'],
  [/^Terminal$/, 'terminal'],
  [/^iTerm2?$/, 'iterm'],
  [/^Ghostty$/, 'ghostty'],
  [/^cmux$/i, 'cmux'],
  [/^(?:Visual Studio Code|Code)(?: - Insiders)?$|^VSCodium$/, 'vscode'],
  [/^Warp(?:Preview)?$/, 'warp'],
];

/** The app a bundle path is, with its own name (the bundle's file name without `.app`). */
export function appOfBundle(bundle: string): { app: HostApp; name: string } {
  const name = bundle
    .replace(/^.*\//, '')
    .replace(/\.app$/, '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .trim()
    .slice(0, 60);
  return { app: BUNDLES.find(([pattern]) => pattern.test(name))?.[1] ?? 'app', name };
}

/** Claude's own tmux server for teammates: `tmux -L claude-swarm-<pid>`. */
export const isSwarmSocket = (socket: string) => /(?:^|\/)claude-swarm-\d+$/.test(socket);

/**
 * Pure: where process `pid` runs, from the process table and its environment. The program
 * holding its pty decides, as for a verified host: tmux (any tmux marker counts, as it never
 * routes to an outer terminal), then Orca; else the first ancestor that is a macOS app.
 * `platform`: apps are macOS bundles; elsewhere only tmux is found.
 */
export function placeOfProcess(
  table: string,
  pid: number,
  env: ProcessEnv,
  platform: string = process.platform,
): HostPlace {
  const owner = ptyOwner(table, pid);
  if (env.inTmux || (owner && isTmux(owner.command))) {
    const app = env.tmuxSocket && isSwarmSocket(env.tmuxSocket) ? 'swarm' : 'tmux';
    return env.tmuxSocket && env.tmuxPane
      ? {
          where: 'tmux',
          host: { app, canGo: true },
          way: { kind: 'tmux', socket: env.tmuxSocket, pane: env.tmuxPane },
        }
      : { where: 'tmux', host: { app }, way: { kind: 'none' } };
  }
  if (platform !== 'darwin') return NOWHERE;
  const orca: HostPlace = {
    where: 'orca',
    host: { app: 'orca', canGo: true },
    way: { kind: 'orca', ...(env.orcaHandle && { handle: env.orcaHandle }) },
  };
  if (owner && isOrca(owner.command)) return orca;
  const bundle = ancestorBundle(processRows(table), pid);
  if (!bundle) return NOWHERE;
  const { app, name } = appOfBundle(bundle);
  // Inside Orca (a nested terminal program): the Orca terminal it was started in shows it.
  if (app === 'orca') return orca;
  return {
    where: 'other',
    host: { app, ...(app === 'app' && name && { name }), canGo: true },
    way: { kind: 'app', bundle, name, ...(owner && { tty: `/dev/${owner.tty}` }) },
  };
}

/**
 * Where a live process runs (`placeOfProcess`). Its environment is read once for its life,
 * shared with the terminal lookup (`view:`), and the process table once a second (shared too).
 * A failed read is not remembered.
 */
export async function hostOf(
  proc: { pid: number; procStart: string },
  deps: TerminalHostDeps,
): Promise<HostPlace> {
  const key = `${proc.pid}:${proc.procStart}`;
  const view = remember<ProcessView>(deps, `view:${key}`, Infinity, false, () =>
    inspectProcess(proc.pid, deps),
  );
  const { env, owner } = await view;
  if (!owner) forget(deps, `view:${key}`);
  const table = await remember(deps, 'process-table', 1000, false, () =>
    deps.run('/bin/ps', ['-axo', 'pid=,ppid=,tty=,comm=']),
  ).catch(() => '');
  if (!table.trim()) forget(deps, 'process-table');
  return placeOfProcess(table, proc.pid, env, deps.platform ?? process.platform);
}

/**
 * Brings a running place forward; nothing is typed (#376). A verified terminal: as any jump.
 * Orca: the terminal its process was started in while Orca still lists it, else the
 * conversation's tab matched by its title (`tab`), else Orca itself. tmux: the pane its
 * environment names, while that pane exists. Terminal and iTerm2: the tab showing its tty, else
 * the app; any other app: the app. A background session: its attach command, to copy. Throws a
 * `TerminalFocusError` (its message may be shown) when there is no way there.
 */
export async function reachHost(
  place: HostPlace,
  deps: TerminalHostDeps,
  tab?: () => Promise<TerminalHost | null>,
): Promise<JumpResult> {
  const t = m().desktop.terminal;
  const focused = (text: string): JumpResult => ({
    action: 'focused',
    text: place.host.parked ? `${text} ${t.parkedHint}` : text,
  });
  const way = place.way;
  const raise = async (bundle: string, name: string) => {
    try {
      await deps.run('/usr/bin/open', ['-a', bundle]);
    } catch {
      throw new TerminalFocusError(t.jumpFailed(name));
    }
    return focused(t.appRaised(name));
  };
  switch (way.kind) {
    case 'terminal':
      return focused(await focusHost(way.host, deps));
    case 'attach':
      return { action: 'copy', text: way.command };
    case 'orca': {
      const listed = way.handle ? (await orcaTerminals(deps, true)).get(way.handle) : undefined;
      if (
        way.handle &&
        listed &&
        listed.orphaned !== true &&
        (listed.executionHostId === undefined || listed.executionHostId === 'local')
      )
        try {
          return focused(await focusHost({ kind: 'orca', handle: way.handle, title: '' }, deps));
        } catch {
          /* Not mounted, or gone meanwhile: its tab by title, else Orca itself. */
        }
      const matched = await tab?.().catch(() => null);
      if (matched)
        try {
          return focused(await focusHost(matched, deps));
        } catch {
          /* Orca itself below. */
        }
      return raise('Orca', 'Orca');
    }
    case 'tmux': {
      const label = (
        await deps
          .run(deps.bin('tmux'), [
            '-S',
            way.socket,
            'display-message',
            '-p',
            '-t',
            way.pane,
            '#{session_name}:#{window_index}.#{pane_index}',
          ])
          .catch(() => '')
      ).trim();
      if (!label) throw new TerminalFocusError(t.jumpFailed(hostPlaceName(place.host)));
      return focused(
        await focusHost({ kind: 'tmux', socket: way.socket, pane: way.pane, label }, deps),
      );
    }
    case 'app': {
      const name = hostPlaceName(place.host);
      if (way.tty && (await focusTtyTab(way.name, way.tty, deps)))
        return focused(t.appTabFocused(name));
      return raise(way.bundle, name);
    }
    case 'none':
      throw new TerminalFocusError(t.noWay);
  }
}

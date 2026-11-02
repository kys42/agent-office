import path from 'node:path';
import type { Session } from '../../src/shared/types.js';
import { TmuxResume, defaultResumeDeps } from '../../desktop/tmux-resume.js';
import { OrcaLaunch } from '../../desktop/orca-launch.js';
import { LaunchCore, type LaunchTarget } from '../../desktop/launch/core.js';
import { orcaDestination, tmuxDestination } from '../../desktop/launch/destinations.js';
import { PendingLaunches } from '../../desktop/pending-launch.js';
import type { RemoteLaunchSpec } from '../../src/shared/remote-launch.js';

export interface PeerLauncher {
  status(cwd: string, spec: RemoteLaunchSpec): Promise<{ tmux: boolean; orca: boolean }>;
  start(
    cwd: string,
    spec: RemoteLaunchSpec,
    authorized: () => void,
  ): Promise<'started' | 'running' | 'uncertain'>;
}
/**
 * Separate managed tmux server; Orca tabs never steal the remote user's focus. The same launch
 * core as a local launch (desktop/launch/core.ts), with its own queue position and pending
 * record in this process; its confirmation is the requester's, checked again by `authorized`.
 */
export function nativePeerLauncher(): PeerLauncher {
  const tmux = new TmuxResume();
  let orcaPath = '';
  const orca = new OrcaLaunch(() => orcaPath);
  const core = new LaunchCore({
    destinations: { tmux: tmuxDestination(tmux), orca: orcaDestination(orca) },
    pending: new PendingLaunches(),
  });
  const target = (cwd: string, spec: RemoteLaunchSpec, executable: string): LaunchTarget => ({
    kind: 'new',
    provider: spec.provider,
    cwd,
    name: spec.name.normalize('NFC'),
    initialMessage: spec.initialMessage,
    background: true,
    executable,
  });
  return {
    async status(cwd, spec) {
      if (!(await defaultResumeDeps.directory(cwd))) return { tmux: false, orca: false };
      let executable: string;
      try {
        executable = await defaultResumeDeps.binary(spec.provider);
      } catch {
        return { tmux: false, orca: false };
      }
      orcaPath = await defaultResumeDeps.binary('orca').catch(() => '');
      const t = target(cwd, spec, executable);
      const [onTmux, onOrca] = await Promise.all([
        core.probe(t, 'tmux', true),
        core.probe(t, 'orca', true),
      ]);
      return { tmux: onTmux.available, orca: onOrca.available };
    },
    async start(cwd, spec, authorized) {
      const executable = await defaultResumeDeps.binary(spec.provider);
      orcaPath = await defaultResumeDeps.binary('orca').catch(() => '');
      const outcome = await core.start(target(cwd, spec, executable), spec.host, {
        confirm: async () => {
          authorized();
          return true;
        },
        authorized,
      });
      // Even an answer that starts nothing is given only while the requester may still ask.
      authorized();
      if (outcome.state === 'running') return 'running';
      if (outcome.state === 'launched') return 'started';
      // Orca made the tab but did not confirm it: never answered as started, never replayed.
      if (outcome.state === 'uncertain') return 'uncertain';
      throw Error('launch-failed');
    },
  };
}

/** The project button groups by verified workspace/worktree, never by an arbitrary member cwd. */
export function launchDirectory(s: Session): string {
  const cwd = s.workspace && s.workspace.evidence !== 'unknown' ? s.workspace.worktree : s.cwd;
  if (!cwd || !path.isAbsolute(cwd) || /[\x00-\x1f\x7f]/.test(cwd))
    throw Error('Project unavailable');
  return cwd;
}

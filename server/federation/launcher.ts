import path from 'node:path';
import type { Session } from '../../src/shared/types.js';
import { TmuxResume, defaultResumeDeps, summonSession } from '../../desktop/tmux-resume.js';
import { OrcaLaunch } from '../../desktop/orca-launch.js';
import type { RemoteLaunchSpec } from '../../src/shared/remote-launch.js';

export interface PeerLauncher {
  status(cwd: string, spec: RemoteLaunchSpec): Promise<{ tmux: boolean; orca: boolean }>;
  start(
    cwd: string,
    spec: RemoteLaunchSpec,
    authorized: () => void,
  ): Promise<'started' | 'running'>;
}
/** Separate managed tmux server; Orca tabs never steal the remote user's focus. */
export function nativePeerLauncher(): PeerLauncher {
  const tmux = new TmuxResume();
  let orcaPath = '';
  const orca = new OrcaLaunch(() => orcaPath);
  const session = (cwd: string, spec: RemoteLaunchSpec) => ({
    ...summonSession(cwd, spec.provider, spec.name, spec.initialMessage),
    alias: spec.name,
    background: true,
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
      const s = { ...session(cwd, spec), executable };
      const [t, o] = await Promise.all([
        tmux.status(s).then(
          () => true,
          () => false,
        ),
        orca.status(s).then(
          (v) => v.available,
          () => false,
        ),
      ]);
      return { tmux: t, orca: o };
    },
    async start(cwd, spec, authorized) {
      const executable = await defaultResumeDeps.binary(spec.provider);
      orcaPath = await defaultResumeDeps.binary('orca').catch(() => '');
      const s = { ...session(cwd, spec), executable };
      if (spec.host === 'tmux') {
        const before = await tmux.status(s);
        authorized();
        if (before.running) return 'running';
        const result = await tmux.start(
          s,
          async () => {
            authorized();
            return true;
          },
          authorized,
        );
        if (!result.running) throw Error('launch-failed');
      } else {
        const result = await orca.start(
          s,
          async () => {
            authorized();
            return true;
          },
          authorized,
        );
        if (!result.launched) throw Error('launch-failed');
      }
      return 'started';
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

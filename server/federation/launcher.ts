import { desktopApp, wakeDesktop, peerBinary, waitForDestination, resumeOrigin } from './wake.js';
import { checkDuplicate, livenessFor } from '../../desktop/launch-guard.js';
import { defaultTerminalDeps } from '../../desktop/terminals.js';
import { findCodexDestination } from '../../desktop/codex-send.js';
import { lookupOrcaTab } from '../../desktop/orca-tabs.js';
import { matchSleeping } from '../../desktop/orca-sleeping.js';
import path from 'node:path';
import type { Session } from '../../src/shared/types.js';
import { TmuxResume, defaultResumeDeps } from '../../desktop/tmux-resume.js';
import { OrcaLaunch } from '../../desktop/orca-launch.js';
import { LaunchCore, type LaunchTarget } from '../../desktop/launch/core.js';
import { orcaDestination, tmuxDestination } from '../../desktop/launch/destinations.js';
import { PendingLaunches } from '../../desktop/pending-launch.js';
import type { RemoteLaunchSpec } from '../../src/shared/remote-launch.js';

export interface PeerLauncher {
  status(
    cwd: string,
    spec: RemoteLaunchSpec,
    session?: Session,
  ): Promise<{ tmux: boolean; orca: boolean; desktop?: boolean }>;
  start(
    cwd: string,
    spec: RemoteLaunchSpec,
    authorized: () => void,
    session?: Session,
  ): Promise<'started' | 'running' | 'uncertain'>;
}
/**
 * Separate managed tmux server; Orca tabs never steal the remote user's focus. The same launch
 * core as a local launch (desktop/launch/core.ts), with its own queue position and pending
 * record in this process; its confirmation is the requester's, checked again by `authorized`.
 */
export function nativePeerLauncher(): PeerLauncher {
  const tmux = new TmuxResume({ ...defaultResumeDeps, binary: peerBinary });
  let orcaPath = '';
  const orca = new OrcaLaunch(() => orcaPath);
  const pending = new PendingLaunches();
  const core = new LaunchCore({
    conversationCheck: (target) =>
      !target.from
        ? undefined
        : async (fresh) => {
            const s = target.from!;
            return checkDuplicate(
              {
                agent: async (f) =>
                  (await findCodexDestination(s.nativeId, s.sourcePath, { fresh: f }))
                    ? { kind: 'found', terminal: { where: 'other' } }
                    : livenessFor(s.provider).lookup(s.nativeId, f),
                pending: () => pending.state(s),
                ownTmux: async () => {
                  if (!(await peerBinary('tmux').catch(() => null))) return { kind: 'none' };
                  const own = await tmux.ownPanes(s);
                  return own ? { kind: 'found', terminal: own.at } : { kind: 'none' };
                },
                orcaTab: async (f) =>
                  orcaPath && (await orca.reachable(f))
                    ? lookupOrcaTab(s, { ...defaultTerminalDeps(), bin: () => orcaPath }, f)
                    : { kind: 'none' },
                orcaSleeping: async (f) => {
                  const ws = orcaPath && (await orca.workspaces(f));
                  return ws ? matchSleeping(ws, s) : { kind: 'none' };
                },
              },
              fresh,
            );
          },
    destinations: { tmux: tmuxDestination(tmux), orca: orcaDestination(orca) },
    pending,
  });
  const target = (
    cwd: string,
    spec: RemoteLaunchSpec,
    executable: string,
    session?: Session,
  ): LaunchTarget =>
    spec.resume
      ? {
          kind: 'resume',
          provider: 'codex',
          cwd,
          nativeId: session!.nativeId,
          title: session!.title,
          background: true,
          executable,
          from: session,
        }
      : {
          kind: 'new',
          provider: spec.provider,
          cwd,
          name: spec.name.normalize('NFC'),
          initialMessage: spec.initialMessage,
          background: true,
          executable,
        };
  return {
    async status(cwd, spec, session) {
      if (spec.resume) {
        if (!session) throw Error('Missing conversation');
        const origin = await resumeOrigin(session);
        if (origin !== 'cli')
          return {
            tmux: false,
            orca: false,
            desktop: origin === 'desktop' && !!(await desktopApp()),
          };
      }
      if (!(await defaultResumeDeps.directory(cwd))) return { tmux: false, orca: false };
      let executable: string;
      try {
        executable = await peerBinary(spec.provider);
      } catch {
        return { tmux: false, orca: false };
      }
      orcaPath = await defaultResumeDeps.binary('orca').catch(() => '');
      const t = target(cwd, spec, executable, session);
      if (spec.resume && (await core.guard(t)(true)).state !== 'none')
        return { tmux: false, orca: false };
      const [onTmux, onOrca] = await Promise.all([
        core.probe(t, 'tmux', true),
        core.probe(t, 'orca', true),
      ]);
      return { tmux: onTmux.available, orca: onOrca.available };
    },
    async start(cwd, spec, authorized, session) {
      if (spec.resume) {
        if (!session) throw Error('Missing conversation');
        const origin = await resumeOrigin(session);
        if (!origin || (origin === 'desktop') !== (spec.host === 'desktop'))
          throw Error('Unsupported conversation');
        if (await findCodexDestination(session.nativeId, session.sourcePath, { fresh: true })) {
          authorized();
          return 'running';
        }
      }
      if (spec.host === 'desktop') {
        if (!session) throw Error('Missing conversation');
        await wakeDesktop(session, authorized);
        return (await waitForDestination(session, authorized)) ? 'started' : 'uncertain';
      }
      const executable = await peerBinary(spec.provider);
      orcaPath = await defaultResumeDeps.binary('orca').catch(() => '');
      const outcome = await core.start(target(cwd, spec, executable, session), spec.host, {
        confirm: async (_probe, check) => {
          authorized();
          return !spec.resume || check.state === 'none';
        },
        authorized,
      });
      // An answer that starts nothing is given only while the requester may still ask. A start
      // that went ahead is never turned into a failure afterwards.
      if (spec.resume && (outcome.state === 'launched' || outcome.state === 'running'))
        return (await waitForDestination(session!, authorized))
          ? outcome.state === 'running'
            ? 'running'
            : 'started'
          : 'uncertain';
      if (outcome.state === 'launched') return 'started';
      // Orca made the tab but did not confirm it: never answered as started, never replayed.
      if (outcome.state === 'uncertain') return 'uncertain';
      authorized();
      if (outcome.state === 'running') return 'running';
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

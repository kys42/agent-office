import { RemoteSummon } from './RemoteSummon';
import { api } from '../lib/api';
import type { Session } from '../shared/types';
import { TmuxResume } from './TmuxResume';
import { SummonExisting } from './SummonExisting';
import { awayColleagues } from '../shared/summon-existing';
import type { OfficeModel } from '../shared/office-model';

/** What the "+" needs to offer bringing back an away colleague of this project. */
export interface BringBack {
  zones: OfficeModel['zones'];
  /** The existing "bring back to the office" (unarchive + return time). */
  onReturn: (id: string) => unknown;
}
/** A custom zone may hold several actual project folders: never guess which one to launch in. */
export function ProjectSummon({
  sessions,
  privacy,
  notify,
  demo = false,
  bringBack,
}: {
  sessions: Session[];
  bringBack?: BringBack;
  privacy: boolean;
  notify: (message: string) => void;
  demo?: boolean;
}) {
  const remote = [
    ...new Map(
      sessions
        .filter((s) => s.remote)
        .map((s) => [
          s.remote!.officeId +
            ':' +
            (s.workspace?.key ?? s.project) +
            ':' +
            (s.workspace?.worktree ?? ''),
          s,
        ]),
    ).values(),
  ];
  if (!demo && !privacy && api.remoteLaunch && remote.length && !sessions.some((s) => !s.remote))
    return <RemoteSummon projects={remote} privacy={privacy} notify={notify} />;
  const projects = [
    ...new Map(sessions.filter((s) => !s.remote && s.cwd).map((s) => [s.cwd, s])).values(),
  ];
  if (!api.tmuxSummon || demo || privacy || !projects.length) return null;
  const away = bringBack && api.tmuxResume ? awayColleagues(bringBack.zones, sessions) : null;
  return (
    <TmuxResume
      id={projects[0].id}
      projects={projects}
      privacy={privacy}
      notify={notify}
      summon
      existing={
        away
          ? (close) => (
              <SummonExisting
                colleagues={away.list}
                total={away.total}
                privacy={privacy}
                notify={notify}
                onReturn={bringBack!.onReturn}
                close={close}
              />
            )
          : undefined
      }
    />
  );
}

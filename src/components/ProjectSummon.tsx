import { useState } from 'react';
import { Plus } from 'lucide-react';
import { RemoteSummon } from './RemoteSummon';
import { LaunchSheet } from './LaunchSheet';
import { ZoneShellButton } from './MiniShell';
import { api } from '../lib/api';
import { useLaunchSupport } from '../lib/useLaunchSupport';
import { useI18n } from '../lib/i18n';
import { conversationChoices } from '../shared/launch-sheet';
import type { Session } from '../shared/types';
import type { OfficeModel } from '../shared/office-model';

/** What the "+" needs to offer bringing back an away colleague of this project. */
export interface BringBack {
  zones: OfficeModel['zones'];
  /** The existing "bring back to the office" (unarchive + return time). */
  onReturn: (id: string) => unknown;
}
/**
 * A project's "+": the launch sheet (#319) for a new session in its folder, or for continuing
 * or forking one of its conversations (the office's, then the lounge's and the archive's).
 * A custom zone may hold several actual project folders: never guess which one to launch in.
 * A project of a connected remote office keeps its own summon (RemoteSummon).
 */
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
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // Hidden where no destination can ever work on this platform (main decides, e.g. Windows).
  const support = useLaunchSupport();
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
  const launchable =
    !!support?.supported && !!api.launch && !!api.launchOptions && !demo && projects.length > 0;
  const choices = open ? conversationChoices(bringBack?.zones, sessions) : null;
  return (
    <>
      {launchable && !privacy && (
        <button
          className="project-summon-button"
          data-solid
          aria-label={t.launchSheet.title}
          title={t.launchSheet.title}
          onClick={() => setOpen(true)}
        >
          <Plus size={15} />
        </button>
      )}
      {launchable && open && choices && (
        <LaunchSheet
          entry={{ from: 'project', projects, choices: choices.list, hidden: choices.hidden }}
          privacy={privacy}
          notify={notify}
          onClose={() => setOpen(false)}
          onReturn={bringBack?.onReturn}
        />
      )}
      <ZoneShellButton sessions={sessions} privacy={privacy} demo={demo} notify={notify} />
    </>
  );
}

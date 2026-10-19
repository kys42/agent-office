import { api } from '../lib/api';
import type { Session } from '../shared/types';
import { TmuxResume } from './TmuxResume';
/** A custom zone may hold several actual project folders: never guess which one to launch in. */
export function ProjectSummon({
  sessions,
  privacy,
  notify,
  demo = false,
}: {
  sessions: Session[];
  privacy: boolean;
  notify: (message: string) => void;
  demo?: boolean;
}) {
  const projects = [
    ...new Map(sessions.filter((s) => !s.remote && s.cwd).map((s) => [s.cwd, s])).values(),
  ];
  if (!api.tmuxSummon || demo || privacy || !projects.length) return null;
  return (
    <TmuxResume id={projects[0].id} projects={projects} privacy={privacy} notify={notify} summon />
  );
}

import { MessageSquare, Terminal } from 'lucide-react';
import type { Session } from '../shared/types';
import { sessionActivity, activityLabel, toolLabel } from '../shared/activity';
import { ago, date, time } from '../lib/format';
import { useI18n } from '../lib/i18n';

export function ActivitySummary({ session }: { session: Session }) {
  const { t } = useI18n();
  const activity = sessionActivity(session);
  return (
    <section className="progress-summary" aria-label={t.now.progress}>
      <div className="progress-summary-label">
        <MessageSquare size={12} />
        <b>{activityLabel(session)}</b>
        <time title={`${date(activity.at)} ${time(activity.at)}`}>{ago(activity.at)}</time>
      </div>
      <p title={activity.text}>{activity.text}</p>
      {activity.tool && (
        <div className="activity-tool" title={activity.tool.name}>
          <Terminal size={12} />
          <span>{t.now.lastTool(toolLabel(activity.tool.name))}</span>
          <time>{ago(activity.tool.at)}</time>
        </div>
      )}
    </section>
  );
}

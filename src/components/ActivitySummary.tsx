import { MessageSquare, Terminal } from 'lucide-react';
import type { Session } from '../shared/types';
import { sessionActivity, activityLabel, toolLabel } from '../shared/activity';
import { ago, date, time } from '../lib/format';

export function ActivitySummary({ session }: { session: Session }) {
  const activity = sessionActivity(session);
  return (
    <section className="progress-summary" aria-label="최근 진행 설명">
      <div className="progress-summary-label">
        <MessageSquare size={12} />
        <b>{activityLabel(session)}</b>
        <time title={`${date(activity.at)} ${time(activity.at)}`}>{ago(activity.at)}</time>
      </div>
      <p title={activity.text}>{activity.text}</p>
      {activity.tool && (
        <div className="activity-tool" title={activity.tool.name}>
          <Terminal size={12} />
          <span>최근 도구 · {toolLabel(activity.tool.name)}</span>
          <time>{ago(activity.tool.at)}</time>
        </div>
      )}
    </section>
  );
}

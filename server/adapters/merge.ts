import type { Session } from '../../src/shared/types.js';
import { hash } from './normalize.js';
import { summarizeActivity } from '../../src/shared/activity.js';

// Platform-independent: multiple transport fragments may describe one native conversation.
export function mergeSessions(input: Session[]): Session[] {
  const groups = new Map<string, Session[]>();
  for (const s of input) groups.set(s.id, [...(groups.get(s.id) ?? []), s]);
  return [...groups.values()]
    .map((group) => {
      group.sort((a, b) => a.updatedAt - b.updatedAt || a.observedAt - b.observedAt);
      const latest = group.at(-1)!;
      if (group.length === 1) return latest;
      const events = [
        ...new Map(group.flatMap((s) => s.events).map((e) => [e.id, e])).values(),
      ].sort((a, b) => a.at - b.at);
      // Compact transport tails can omit the public message retained by the adapter.
      for (const s of group) {
        const a = s.activity;
        if (a?.eventId && a.kind !== 'status' && !events.some((e) => e.id === a.eventId))
          events.push({
            id: a.eventId,
            at: a.at,
            kind: a.kind === 'request' ? 'user' : 'assistant',
            text: a.text,
            phase: a.kind === 'progress' ? 'commentary' : a.kind === 'reply' ? 'final' : undefined,
            sourceRef: s.sourcePath,
          });
      }
      events.sort((a, b) => a.at - b.at);
      const activity = summarizeActivity(
        events,
        latest.observedStatus ?? latest.status,
        latest.updatedAt,
      );
      return {
        ...latest,
        sourcePaths: [...new Set(group.flatMap((s) => s.sourcePaths ?? [s.sourcePath]))].sort(),
        title: [...group].reverse().find((s) => s.nativeTitle)?.title ?? group[0].title,
        nativeTitle: group.some((s) => s.nativeTitle),
        startedAt: Math.min(...group.map((s) => s.startedAt)),
        events: events.slice(-180),
        partial: group.some((s) => s.partial) || events.length > 180,
        artifacts: [...new Set(group.flatMap((s) => s.artifacts))].slice(-12),
        activity,
        action: activity.text,
        revision: hash(group.map((s) => s.revision).join(':')),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

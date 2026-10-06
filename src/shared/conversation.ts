import { messageExcerpt } from './activity';
import type { OfficeEvent, OfficeNotice } from './types';

export type ConversationKind = 'request' | 'progress' | 'reply' | 'message' | 'work';
export type ConversationFilter = 'all' | Exclude<ConversationKind, 'work'>;
export const CONVERSATION_LABELS: Record<ConversationKind, string> = {
  request: '내 요청',
  progress: '진행 상황',
  reply: '최종 응답',
  message: '기타 응답',
  work: '도구 기록',
};
/** A public assistant message is final only when its source provides completion evidence. */
export function conversationKind(e: OfficeEvent): ConversationKind {
  if (e.kind === 'user') return 'request';
  if (e.kind !== 'assistant') return 'work';
  return e.phase === 'final' ? 'reply' : e.phase === 'commentary' ? 'progress' : 'message';
}
export function conversationEvents(events: OfficeEvent[]) {
  const out: OfficeEvent[] = [],
    seen = new Map<string, number>();
  for (const e of events) {
    // Codex may expose both message and event forms. Different phases are not duplicates.
    const key = `${e.kind}:${e.phase ?? ''}:${e.text}`;
    if (
      ['user', 'assistant'].includes(e.kind) &&
      Math.abs(e.at - (seen.get(key) ?? -Infinity)) < 3000
    )
      continue;
    seen.set(key, e.at);
    out.push(e);
  }
  return out;
}

/** Fill gaps in bounded source windows with explicitly labelled, locally retained excerpts. */
export function retainedConversation(events: OfficeEvent[], notices: OfficeNotice[]) {
  const result = [...events];
  for (const n of notices) {
    if (!['request', 'progress', 'reply', 'message'].includes(n.kind)) continue;
    const kind = n.kind === 'request' ? 'user' : 'assistant';
    const phase = n.phase ?? (n.kind === 'progress' ? 'commentary' : undefined);
    if (
      result.some(
        (e) =>
          e.id === n.eventId ||
          (e.kind === kind &&
            e.phase === phase &&
            Math.abs(e.at - n.at) < 3000 &&
            messageExcerpt(e.text, 800) === n.text),
      )
    )
      continue;
    result.push({
      id: n.eventId,
      kind,
      phase,
      at: n.at,
      text: n.text,
      sourceRef: `notice:${n.id}`,
      excerpt: true,
    });
  }
  return conversationEvents(result.sort((a, b) => a.at - b.at));
}

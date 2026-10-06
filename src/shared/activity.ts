import type { Activity, Mood, OfficeEvent, Session } from './types.js';

// Display an excerpt of public messages; never turn tool names into invented task descriptions.
export function messageExcerpt(text: string, limit = 220): string {
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > limit ? plain.slice(0, limit - 1).trimEnd() + '…' : plain;
}

export function summarizeActivity(
  events: OfficeEvent[],
  status: Mood,
  updatedAt: number,
): Activity {
  // A new turn must not inherit an old answer as its current intention.
  const boundary = events.findLastIndex((e) => e.kind === 'user' || e.lifecycle === 'started');
  const current = events.slice(Math.max(0, boundary));
  const assistant = current.findLast((e) => e.kind === 'assistant' && messageExcerpt(e.text));
  const request = current.findLast((e) => e.kind === 'user' && messageExcerpt(e.text));
  const tool = current.findLast((e) => e.kind === 'tool' && e.tool);
  const source = assistant ?? request;
  const fallback: Partial<Record<Mood, string>> = {
    call: '원래 앱에서 질문이나 입력 요청을 확인해 주세요',
    done: '이번 응답을 마쳤어요',
    idle: '새 활동 기록을 기다리고 있어요',
    sleep: '한동안 새 활동 기록이 없어요',
    leave: '보관된 작업 기록이에요',
    error: '원래 앱에서 작업 상태를 확인해 주세요',
  };
  return {
    text: source
      ? messageExcerpt(source.text)
      : (fallback[status] ?? '작업 기록은 있지만 진행 설명은 아직 없어요'),
    kind: assistant
      ? assistant.phase === 'commentary'
        ? 'progress'
        : assistant.phase === 'final'
          ? 'reply'
          : 'message'
      : request
        ? 'request'
        : 'status',
    at: source?.at ?? updatedAt,
    eventId: source?.id,
    ...(tool ? { tool: { name: tool.tool!, at: tool.at } } : {}),
  };
}

export const sessionActivity = (s: Session): Activity =>
  s.activity ?? summarizeActivity(s.events, s.observedStatus ?? s.status, s.updatedAt);

export function activityLabel(s: Session, now = Date.now()): string {
  const a = sessionActivity(s);
  if (a.kind === 'request') return '받은 요청';
  if (a.kind === 'status') return '기록 상태';
  if (a.kind === 'reply') return '최근 응답';
  const old = now - a.at > 120_000 || !['work', 'think', 'call'].includes(s.status);
  return a.kind === 'progress' ? (old ? '마지막 진행 메시지' : '진행 메시지') : '최근 메시지';
}

export function toolLabel(name: string): string {
  const short = name.replace(/^.*[._]{2}/, '');
  if (/^(exec|exec_command|Bash|bash|shell_command|shell)$/i.test(short)) return '터미널';
  if (/^(apply_patch|Edit|MultiEdit|Write)$/i.test(short)) return '파일 수정';
  if (/^(Read|read_file|read_files)$/i.test(short)) return '파일 읽기';
  if (/^(Grep|Glob|search_files)$/i.test(short)) return '파일 검색';
  if (/^(web|web_search|webfetch|web__run)$/i.test(short)) return '웹 조회';
  if (/request_user_input|AskUserQuestion/i.test(short)) return '입력 요청';
  if (/^(wait|write_stdin|sleep)$/i.test(short)) return '결과 확인';
  return short.length > 26 ? short.slice(0, 25) + '…' : short;
}

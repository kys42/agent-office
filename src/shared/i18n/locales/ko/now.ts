import type { Messages } from '../en';

export const now: Messages['now'] = {
  region: '지금 상태',
  hidden: '내용을 숨기고 있어요',
  needsLook: '확인이 필요해요',
  waitingReply: '답변을 기다리고 있어요',
  newResult: (n) => `새 결과가 도착했어요${n > 1 ? ` · ${n}건` : ''}`,
  working: (elapsed) => `작업 중 · ${elapsed}`,
  inProgress: '진행 중',
  standby: '대기 중 · 방금 일을 마쳤어요',
  quiet: '지금은 조용해요',
  less: '접기',
  more: '더 보기',
  markAllRead: (n) => `${n}건 모두 읽음`,
  markRead: '읽음으로 표시',
  viewUpdate: '소식에서 보기',
  finalNote: '최종 응답은 이번 답변의 끝이에요. 업무 전체의 성공과는 달라요.',
  ack: '확인했어요',
  replyNote: '답변과 승인은 원래 앱에서 해 주세요. Agent Office는 기록을 읽기만 해요.',
  typeNote: '승인 요청은 원래 앱에서 답해 주세요. 쉬는 중이면 아래에서 바로 이어서 말할 수 있어요.',
  typeQueuedNote:
    '승인 요청은 원래 앱에서 답해 주세요. 아래에서 보낸 말은 지금 작업이 끝난 뒤 처리돼요.',
  progress: '최근 진행 설명',
  lastTool: (tool) => `최근 도구 · ${tool}`,
};

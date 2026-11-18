import type { Messages } from '../en';

export const common: Messages['common'] = {
  justNow: '방금',
  minutesAgo: (m) => `${m}분 전`,
  hoursAgo: (h) => `${h}시간 전`,
  daysAgo: (d) => `${d}일 전`,
  pathUnknown: '아직 확인되지 않았어요',
  crash: {
    title: '사무실을 다시 열어볼까요?',
    body: '표시 중 문제가 생겼어요. 원본 세션은 안전하게 보관되어 있어요.',
    reload: '다시 열기',
  },
  language: {
    auto: '시스템 언어',
  },
  onTop: {
    name: '맨 위에 두기',
    states: { off: '보통 창', on: '맨 위' },
    hints: { off: '다른 창 뒤로 갈 수 있어요', on: '늘 다른 창 위에 있어요' },
    label: (now, next) => `맨 위에 두기: ${now} → ${next}`,
  },
};

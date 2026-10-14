import type { Messages } from '../en';

export const dock: Messages['dock'] = {
  arrange: {
    move: (name) => `구역 옮기기 · ${name}`,
    hint: '끌어서 좌우로 옮기기 · ← → (Shift: 크게) · Home/End: 양 끝 · Esc: 취소',
    reset: '기본 배치로 되돌리기',
    saveFailed: '위치를 기억하지 못했어요. 이번 창에서는 그대로 사용할 수 있어요.',
  },
  pinned: '고정했어요',
  status: {
    check: '연결 확인',
    connecting: '연결 중',
    error: (error) => `연결을 확인해 주세요 · ${error}`,
    opening: '사무실 문을 여는 중…',
  },
  pet: {
    aria: (label, count) => `데스크 펫 · ${label}${count ? ` ${count}명` : ''} · 눌러서 펼치기`,
    title: (total) =>
      `우리 사무실 · 동료 ${total}명\n누르면 마지막에 쓴 모습(책상 줄·바닥 책상)으로 펼쳐지고, 끌어서 옮길 수 있어요`,
    unread: (n) => `읽지 않은 소식 ${n}건 · `,
    detailHint: '누르면 크게 보여요 · 업무 카드는 옆 도구에서',
    someone: '동료',
    openCard: '업무 카드 열기',
    openCardTitle: '팝업으로 보기 · 말하는 동료의 업무 카드',
    expand: '사무실 펼치기',
    expandTitle: '큰 사무실 열기',
    refresh: '새로고침',
    refreshTitle: '새로고침 · 지금 기록을 다시 확인해요',
    floor: '바닥 책상 펼치기',
    floorTitle: '바닥 책상 · 화면 맨 아래에 책상만, 구역은 깃발',
    previous: '이전 동료',
    previousTitle: '이전 동료 보기 · ←',
    next: '다음 동료',
    nextTitle: '다음 동료 보기 · →',
    place: (at, total) => `${at}/${total}`,
    hide: '데스크 펫 숨기기',
    hideTitle: '숨기기 · 트레이에서 다시 열 수 있어요',
  },
  card: {
    missing: '이 동료를 찾지 못했어요',
    opening: '업무 카드를 여는 중…',
  },
};

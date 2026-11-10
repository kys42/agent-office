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
    aria: (label, count) =>
      `데스크 펫 · ${label}${count ? ` ${count}명` : ''} · 눌러서 업무 카드 열기`,
    title: (total) =>
      `우리 사무실 · 동료 ${total}명\n누르면 이 동료의 업무 카드가 열리고, 끌어서 옮길 수 있어요 · 책상은 보기에서 펼쳐요`,
    detailHint: '누르면 크게 보여요 · 펫을 누르면 업무 카드',
    someone: '동료',
    openCard: '업무 카드 열기',
    openCardTitle: '팝업으로 보기 · 말하는 동료의 업무 카드',
    openCardOf: (name) => `${name} 업무 카드 열기`,
    listOf: (group, n) => `${group} ${n}명 · 누구인지 보기`,
    previous: '이전 동료',
    previousTitle: '이전 동료 보기 · ←',
    next: '다음 동료',
    nextTitle: '다음 동료 보기 · →',
    place: (at, total) => `${at}/${total}`,
    hide: '데스크 펫 숨기기',
  },
  view: {
    button: '보기',
    label: '보기 바꾸기',
    tip: '보기 바꾸기 · 펫, 줄, 바닥, 쪼꼬미',
    menu: '데스크 보기',
    pet: '데스크 펫',
    petHint: '바탕화면에 펫 하나만',
    row: '책상 줄',
    rowHint: '동료 책상을 한 줄로',
    floor: '바닥',
    floorHint: '프로젝트별 바닥에 책상',
    tiny: '쪼꼬미',
    tinyHint: '줄·바닥을 작게',
    roster: '동료 목록',
    main: '큰 사무실 열기',
    settings: '설정',
    looks: {
      pet: '데스크 펫',
      row: '책상 줄',
      floor: '바닥',
      tinyRow: '쪼꼬미 줄',
      tinyFloor: '쪼꼬미 바닥',
    },
  },
  tips: {
    hide: '숨기기 · 트레이에서 다시 열어요',
    grip: '끌어서 옮기기',
  },
  card: {
    missing: '이 동료를 찾지 못했어요',
    opening: '업무 카드를 여는 중…',
  },
};

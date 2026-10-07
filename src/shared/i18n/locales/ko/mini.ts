import type { Messages } from '../en';

export const mini: Messages['mini'] = {
  title: '우리 사무실',
  count: (n) => `${n}명의 동료`,
  more: ' · 펼치면 모두 보여요',
  expand: '사무실 펼치기',
  hide: '미니 오피스 숨기기',
  open: (name) => `${name} 업무 보기`,
  unread: '새 소식',
  project: '프로젝트',
  empty: '동료들의 기록을 기다리고 있어요.',
};

import type { Messages } from '../en';

export const lounge: Messages['lounge'] = {
  label: '동료들의 휴식 공간',
  neon: '잠시, 느긋하게',
  intro: '새 활동이 생기면 사무실로 돌아와요. 직접 자리를 마련해 줄 수도 있어요.',
  project: '프로젝트',
  offDuty: (n) => `${n}명 퇴근`,
  open: (name) => `${name ?? '동료'} 업무 보기`,
  hiddenTeammate: '숨긴 동료',
  hiddenProject: '프로젝트 숨김',
  active: (ago) => `${ago} 활동`,
  runs: (n) => `실행 기록 ${n}개`,
  bringBack: '사무실로 데려오기',
};

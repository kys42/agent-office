import type { Messages } from '../en';

export const artifacts: Messages['artifacts'] = {
  label: '연결된 PR과 이슈',
  title: '연결된 작업',
  checking: 'GitHub 확인 중',
  sample: '예시 링크',
  verified: 'GitHub 상태 확인됨',
  found: '대화에서 발견한 링크',
  pull: 'PR',
  issue: '이슈',
  state: { open: '열림', closed: '닫힘', merged: '병합됨', draft: '초안' },
  stateUnknown: '상태 미확인',
  demoPull: '안정적인 좌석 배치와 대화 카드',
  demoIssue: '새 기록이 와도 자리는 그대로',
  showLess: '접기',
  more: (n) => `${n}개 더 보기`,
};

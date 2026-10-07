import type { Messages } from '../en';

export const memory: Messages['memory'] = {
  eyebrow: 'Memory',
  title: '기억 서랍',
  intro: '어느 도구에서 했든, 다시 찾고 싶은 작업의 맥락을 꺼내 보세요.',
  placeholder: '프로젝트, 결정, 오류, 기억하고 싶은 단어…',
  searchLabel: '기록 검색',
  clear: '검색어 지우기',
  allTools: '모든 도구',
  withNotes: '메모 있는 기록',
  suggestLabel: '자주 찾는 말',
  suggestions: ['오류', '결정', '테스트', '리팩터링', 'PR'],
  searching: '기록을 찾고 있어요…',
  results: (n) => `${n}개의 기억${n >= 50 ? ' · 최대 50개 표시' : ''}`,
  sort: '최근 활동순',
  hiddenProject: '프로젝트',
  hiddenTitle: '숨긴 작업 기록',
  hiddenBody: '내용을 숨기고 있어요.',
  hasNotes: '메모 있음',
  emptyTitle: '아직 꺼낼 기억이 없어요',
  emptyBody: '다른 단어로 찾아보거나 도구 필터를 바꿔보세요.',
  note: '로컬에 수집된 구간을 검색해요. 큰 기록은 처음과 최근 구간만 포함할 수 있어요.',
};

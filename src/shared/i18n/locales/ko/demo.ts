import type { Messages } from '../en';

export const demo: Messages['demo'] = {
  sessions: [
    { alias: '코코', title: '사무실에 새 동료 맞이하기', action: '세션 수집기를 연결하고 있어요' },
    { alias: '네모', title: '검색 결과를 더 빠르게', action: '검색 흐름을 살펴보는 중' },
    { alias: '집사', title: '오늘의 업무 브리핑', action: '오늘의 기록을 모으고 있어요' },
    { alias: '당근', title: '9월의 작업 회고', action: '회고의 제목을 골라 주세요' },
    { alias: '삑삑', title: '로그인 재시도 오류 수정', action: '회귀 테스트 실행 중' },
    { alias: '모모', title: '컴포넌트 정리', action: '이번 응답을 마쳤어요!' },
    { alias: '큐브', title: '작은 버그를 잡는 시간', action: '잠깐 쉬고 있어요' },
    { alias: '꽃게', title: '주간 일정 정리', action: '다음 이야기를 기다려요' },
  ],
  request: (title) =>
    title +
    ' 작업을 이어서 진행해 주세요. 이전에 정한 방향을 유지하면서 실제 사용하는 흐름까지 확인하면 좋겠습니다.',
  summary:
    '지금까지 확인한 내용을 정리했습니다. 같은 프로젝트의 동료가 가까이 앉고, 새 기록을 받아도 자리를 지키도록 연결했습니다.',
  detail:
    '다음으로 실제 사용 중 맥락이 끊기는 부분을 확인하고 있습니다. 최근 대화를 먼저 보여주고 긴 내용은 필요한 순간에 펼쳐 볼 수 있도록 정리했습니다. ',
  message(action) {
    return `${action}\n\n${this.summary}\n\n${this.detail.repeat(5)}`;
  },
  connectorPath: '데모 데이터',
  connectorMessage: '예시 세션 · 실제 작업과 분리',
  runtimeReason: '데모의 공개 작업 상태',
  statusReason: '인터랙티브 데모 · 예시 상태',
  usageSource: '데모 예시',
};

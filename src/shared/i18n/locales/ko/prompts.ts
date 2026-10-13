import type { Messages } from '../en';

export const prompts: Messages['prompts'] = {
  headline: {
    plan: '플랜 승인',
    permission: (tool, what) => `${tool} 허락할까요: ${what}`,
    permissionBare: (tool) => `${tool} 허락할까요?`,
    more: (n) => ` (외 ${n}개)`,
  },
  card: {
    region: '묻는 내용',
    question: '질문',
    questions: (n) => `질문 ${n}개`,
    multi: '여러 개 고르기',
    plan: '승인할 플랜',
    planFile: (file) => `플랜 파일 · ${file}`,
    showPlan: '플랜 펼치기',
    hidePlan: '플랜 접기',
    permission: (tool) => `권한 확인 · ${tool}`,
    noSummary: '기록된 내용이 없어요',
    other: '직접 입력',
    otherLabel: (n) => `질문 ${n}에 직접 쓴 답`,
    otherPlaceholder: '직접 답을 써 주세요',
    submit: '답 보내기',
    sending: '보내는 중…',
    sent: '보냈어요 · 기록에서 확인하는 중',
    always: '계속 적용돼요',
    checking: '터미널 화면을 읽는 중…',
  },
  unavailable: {
    web: '터미널에서 답해 주세요. 여기서 답하기는 데스크탑 앱에서만 돼요.',
    'no-terminal': 'Orca·tmux 터미널을 찾지 못했어요. 원래 앱에서 답해 주세요.',
    unsupported: (agent) => `${agent}의 질문에는 아직 여기서 답할 수 없어요.`,
    'not-waiting': '지금은 이 요청을 기다리고 있지 않아요.',
    closed: '지금 터미널에 열린 질문이 없어요.',
    mismatch: '화면의 질문이 이 요청과 달라요. 터미널을 확인해 주세요.',
    unreadable: '터미널 화면을 읽지 못했어요.',
    'no-request': '답할 요청이 없어요.',
  },
  result: {
    answered: (host) => `${host}에서 답했어요`,
    answeredUnconfirmed: (host) =>
      `${host}에 보냈지만 기록에 아직 답이 보이지 않아요. 터미널을 확인해 주세요.`,
    off: '설정에서 답하기를 먼저 켜 주세요.',
    changed: '화면의 질문이 달라요. 보내지 않았어요.',
    stateChanged: '답하는 사이 화면이 바뀌어 멈췄어요. 다시 하기 전에 터미널을 확인해 주세요.',
    notOwner: 'Claude가 지금 터미널 앞에 있지 않아요(일시정지 등). 터미널을 확인해 주세요.',
    notWaiting: '이제 이 요청을 기다리고 있지 않아요.',
    notVerified: '고른 답이 화면에 제대로 반영되지 않아 제출하지 않았어요. 터미널을 확인해 주세요.',
    pressedSome: '이미 일부 키를 눌렀으니 터미널을 확인해 주세요.',
    partial: '터미널에서 이미 고르던 답이 있어요. 터미널에서 마저 답해 주세요.',
    busy: '이미 이 요청에 답하는 중이에요. 결과를 기다려 주세요.',
    stillOpen: '보냈지만 질문 창이 아직 열려 있어요. 터미널을 확인해 주세요.',
    badChoice: '화면에 없는 선택지예요.',
    otherTooLong: (max) => `직접 쓴 답은 ${max}자 이하로 써 주세요.`,
    otherEmpty: '직접 쓸 답을 먼저 입력해 주세요.',
    unsupported: (agent) => `${agent}의 질문에는 여기서 답할 수 없어요.`,
    noTarget: '답할 Orca·tmux 터미널을 찾지 못했어요.',
    unreadable: (host) => `${host} 화면을 읽지 못해서 보내지 않았어요.`,
    unconfirmed: (host) =>
      `${host}에 무엇이 들어갔는지 확인하지 못했어요. 다시 하기 전에 터미널을 확인해 주세요.`,
  },
  confirm: {
    enable: '켜기',
    cancel: '취소',
    questions: {
      message: '질문·플랜 승인에 Agent Office에서 답할까요?',
      detail:
        '고른 답을 Claude Code 터미널(Orca·tmux)에 그 질문 창의 키로 입력해요. 내가 직접 누른 것과 같아요. 답할 때마다 화면의 질문이 이 요청과 정확히 같은지 먼저 확인해요. 플랜을 승인하면 Claude가 바로 그 일을 시작해요.',
    },
    permissions: {
      message: '권한 확인에 Agent Office에서 답할까요?',
      detail:
        "고른 답을 Claude Code 터미널(Orca·tmux)에 그 확인 창의 키로 입력해요. 허락하면 그 명령이나 편집이 바로 실행되고, '다시 묻지 않기'를 고르면 계속 허락돼요. 내가 버튼을 누르지 않으면 아무것도 허락하지 않아요. 답할 때마다 화면의 확인 창이 이 요청과 정확히 같은지 먼저 확인해요.",
    },
  },
  settings: {
    questions: '질문·플랜에 답하기',
    questionsHint:
      '업무 카드에서 Claude Code의 질문과 플랜 승인에 답해요. Orca·tmux 터미널의 질문 창에 그 키를 눌러 입력해요. 기본으로 꺼져 있고, 처음 답할 때(또는 여기서 켤 때) 한 번 확인해요.',
    permissions: '권한 확인에 답하기',
    permissionsHint:
      '업무 카드에서 Claude Code의 권한 확인을 같은 방식으로 허락하거나 거절해요. 자동으로 허락하지 않고, 누른 버튼만 보내요. 기본으로 꺼져 있고, 한 번 확인해요.',
  },
};

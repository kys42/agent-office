import type { Messages } from '../en';
export const launch: Messages['launch'] = {
  destination: {
    orca: 'Orca',
    tmux: 'tmux',
    terminalApp: '터미널 앱',
    copy: '명령 복사',
  },
  kind: { new: '새 세션', resume: '이어가기', fork: '복제해서 새로' },
  title: { new: '새 에이전트 소환', resume: '대화 이어가기', fork: '대화 복제' },
  confirm: {
    new: (place) => `이 프로젝트에 새 에이전트를 ${place}에서 띄울까요?`,
    resume: (place) => `이 대화를 ${place}에서 이어갈까요?`,
    fork: (place) => `이 대화를 복제해 ${place}에서 새 세션으로 띄울까요?`,
  },
  intro: {
    new: '이 프로젝트 폴더에서 새 대화를 시작해요.',
    resume: '저장된 이 대화를 이어가요. 새 대화를 만드는 동작은 아니에요.',
    fork: '원래 대화는 그대로 두고, 같은 맥락에서 갈라진 새 대화를 원래 폴더에서 시작해요.',
  },
  start: (place) => `${place}에서 시작`,
  forkOf: '복제할 대화',
  agentUnsupported: '이 에이전트는 오피스에서 터미널로 띄울 수 없어요.',
  forkUnsupported: 'OpenClaw는 대화 복제를 지원하지 않아요.',
  noConversation: '이어갈 저장된 대화가 없어요.',
  orcaMissing: 'Orca가 설치돼 있지 않아요.',
  orcaStopped: 'Orca가 실행 중이 아니에요. Orca를 연 뒤 다시 확인해주세요.',
  orcaSlow: 'Orca가 제때 답하지 않았어요. 잠시 뒤 다시 확인해주세요.',
  orcaUnknownWorkspace:
    'Orca가 이 폴더가 작업 공간인지 답하지 않았어요. 잠시 뒤 다시 확인해주세요.',
  terminalAppUnsupported: '터미널 앱으로 열기는 macOS에서만 지원해요.',
  terminalAppLaunched: '터미널 새 창에서 열었어요.',
  terminalAppFailed: '터미널을 열지 못했어요. 명령을 복사해 터미널에서 실행해주세요.',
  terminalAppDenied:
    'Agent Office가 터미널을 제어할 권한이 없어요. 시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 허용하거나 명령을 복사해주세요.',
  terminalAppUncertain:
    '터미널이 제때 답하지 않아 시작을 확인하지 못했어요. 이미 터미널 창에서 실행 중일 수 있으니 다시 띄우기 전에 확인해주세요.',
  tmuxUncertain:
    'tmux가 제때 답하지 않아 시작을 확인하지 못했어요. 이미 실행 중일 수 있으니 다시 띄우기 전에 상태를 확인해주세요.',
  tmuxLaunched: 'tmux에서 시작했어요. 터미널에서 열어 작업하세요.',
  tmuxRunning: '이 tmux 세션이 이미 실행 중이에요. 터미널에서 열어주세요.',
  copied: '명령을 복사했어요. 터미널에서 실행하세요.',
  copyUnsupported: '실행 명령 복사는 macOS·Linux에서만 지원해요.',
};

import type { Messages } from '../en';
export const pets: Messages['pets'] = {
  characters: {
    claude: {
      name: '코코',
      description: '따뜻한 니트 모자의 동료',
    },
    codex: {
      name: '네모',
      description: '작고 든든한 터미널 로봇',
    },
    openclaw: {
      name: '집게',
      description: '두 손 가득 일하는 꽃게',
    },
    slime: {
      name: '말랑',
      description: '통통 튀는 말랑 슬라임',
    },
    devcat: {
      name: '코딩냥',
      description: '안경 너머 꼼꼼한 개발자',
    },
    pebble: {
      name: '돌돌',
      description: '느긋하고 단단한 조약돌',
    },
    retrobot: {
      name: '삐코',
      description: '다정한 레트로 모니터 로봇',
    },
    cloud: {
      name: '몽실',
      description: '아이디어를 품은 구름 정령',
    },
  },
  colors: {
    original: '원래 색',
    mint: '민트',
    peach: '복숭아',
    lavender: '라벤더',
    sky: '하늘',
    butter: '버터',
  },
  accessories: {
    none: '기본 모습',
    beret: '베레모',
    crown: '왕관',
    sprout: '새싹',
    ribbon: '리본',
    glasses: '안경',
  },
  saveError: '저장하지 못했어요. 다시 시도해 주세요.',
  individualTitle: '이 동료 꾸미기',
  editTitle: '이 동료 꾸미기 · 캐릭터 · 색 · 장식',
  preview: '동작 미리보기',
  walk: '걷기',
  actorScope: '이 동료의 다른 대화에도 같은 모습을 써요.',
  sessionScope: '이 동료에게만 적용해요.',
  chooseCharacter: '어떤 동료가 좋으세요?',
  chooseColor: '마음에 드는 색',
  chooseAccessory: '작은 포인트 하나',
  resetColleague: '도구 기본 모습으로',
  resetProvider: '원래 모습으로',
  cancel: '취소',
  saving: '저장 중…',
  save: '이 모습으로 저장',
  settingsTitle: '우리 동료들의 모습',
  newFriends: '새 친구 5종',
  settingsHint:
    '도구마다 좋아하는 캐릭터를 골라 주세요. 동료의 업무 카드에서는 한 명만 따로 꾸밀 수 있어요.',
  changeCharacter: '캐릭터 바꾸기',
  tooMany: '꾸미기 항목이 너무 많아요',
  providerTitle: (name: string) => `${name} 기본 캐릭터`,
  providerScope: (name: string) =>
    `${name} 동료의 기본 모습이에요. 따로 꾸민 동료는 자신의 모습을 유지해요.`,
  characterLabel: (name: string) => `캐릭터 ${name}`,
  colorLabel: (name: string) => `색상 ${name}`,
  accessoryLabel: (name: string) => `장식 ${name}`,
  providerLabel: (name: string) => `${name} 캐릭터 꾸미기`,
};

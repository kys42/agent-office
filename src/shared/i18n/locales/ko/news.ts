import type { Messages } from '../en';

export const news: Messages['news'] = {
  list: {
    emptyTitle: '놓친 소식이 없어요',
    emptyDetail: '진행 상황은 대화에서 볼 수 있어요.',
    background: '보조·자동',
    hiddenTeammate: '숨긴 동료',
    hiddenText: '소식 내용을 숨겼어요.',
    less: '접기',
    more: '더 보기',
    markUnread: '다시 미확인',
    markRead: '읽음으로 표시',
    dismissTitle: '소식과 미확인 상태는 남아요',
    dismiss: '말풍선 접기',
    dismissed: '말풍선 접힘',
    loadMore: (n) => `소식 더 보기 · ${n}건`,
    loadOlder: '지난 소식 불러오기',
    loadingOlder: '지난 소식을 불러오는 중…',
  },
  feed: {
    kinds: '소식 종류',
    final: '최종 응답',
    attention: '확인 필요',
    all: '전체 기록',
    waiting: (n) => `답변이나 확인을 기다리는 소식 ${n}건`,
    includeRead: '읽은 소식 포함',
    markAllTitle: '선택한 분류의 미확인 소식 전체를 읽음으로 표시',
    markAll: (n) => `미확인 ${n}건 읽음`,
    empty: {
      final: '새 최종 응답이 없어요',
      attention: '지금 확인할 요청이 없어요',
      all: '놓친 기록이 없어요',
    },
    emptyDetail: {
      final: '진행 상황은 대화에서, 지난 소식은 전체 기록에서 볼 수 있어요.',
      attention: '답변이 필요한 질문과 오류는 여기에 따로 모아요.',
      all: '읽은 소식 포함을 켜면 확인한 기록도 볼 수 있어요.',
    },
  },
  inbox: {
    label: '소식함',
    unread: () => ['확인할 소식 ', '건'],
    allClear: '모두 확인했어요',
    body: '동료가 남긴 최종 응답과 나를 기다리는 요청만 모아요. 진행 상황은 대화에서 볼 수 있어요.',
    footnote: '말풍선 접기와 읽음은 별개예요. 접어도 미확인 소식은 남아요.',
  },
};

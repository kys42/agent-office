export const news = {
  list: {
    emptyTitle: 'No missed updates',
    emptyDetail: 'Progress shows up in the conversation.',
    background: 'Helper · auto',
    hiddenTeammate: 'Hidden teammate',
    hiddenText: 'Update hidden.',
    less: 'Show less',
    more: 'Show more',
    markUnread: 'Mark unread',
    markRead: 'Mark as read',
    dismissTitle: 'The update stays, and so does its unread state',
    dismiss: 'Dismiss bubble',
    dismissed: 'Bubble dismissed',
    loadMore: (n: number) => `Show ${n} more`,
  },
  feed: {
    kinds: 'Update type',
    final: 'Final replies',
    attention: 'Needs a look',
    all: 'All',
    waiting: (n: number) => `${n} ${n === 1 ? 'update is' : 'updates are'} waiting on you`,
    includeRead: 'Include read',
    markAllTitle: 'Mark every unread update in this filter as read',
    markAll: (n: number) => `Mark ${n} as read`,
    empty: {
      final: 'No new final replies',
      attention: 'Nothing needs a look right now',
      all: 'Nothing missed',
    },
    emptyDetail: {
      final: 'Progress lives in the conversation; past updates are under All.',
      attention: 'Questions that need an answer and errors gather here.',
      all: "Turn on Include read to see updates you've already checked.",
    },
  },
  inbox: {
    label: 'Inbox',
    /** [before, after] the bolded unread count. */
    unread: (n: number): [string, string] => [
      '',
      n === 1 ? ' update to check' : ' updates to check',
    ],
    allClear: "You're all caught up",
    body: 'Only final replies from teammates and requests waiting on you. Progress shows up in the conversation.',
    footnote: "Dismissing a bubble doesn't mark it read. Dismissed updates stay unread.",
  },
};

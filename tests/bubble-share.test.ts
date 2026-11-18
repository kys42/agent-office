import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addToDraft,
  bubbleSpeaker,
  formatBubbles,
  handedText,
  handTargets,
  pickInRange,
  rangeIds,
  REPLY_MAX,
  startRange,
  takesReplies,
  type SpeakerLabels,
} from '../src/shared/bubble-share.js';
import { demoSnapshot } from '../src/lib/demo.js';
import type { Session } from '../src/shared/types.js';

const order = ['a', 'b', 'c', 'd', 'e'];

test('"Select from here" starts a run of one; picking moves its end, before the start too', () => {
  let range = startRange('b');
  assert.deepEqual(rangeIds(order, range), ['b']);
  range = pickInRange(range, 'd');
  assert.deepEqual(rangeIds(order, range), ['b', 'c', 'd']);
  // Picking again adjusts the same run (Shift+click does the same).
  range = pickInRange(range, 'c');
  assert.deepEqual(rangeIds(order, range), ['b', 'c']);
  // Above the start: everything from there down to the start.
  range = pickInRange(range, 'a');
  assert.deepEqual(range, { start: 'b', end: 'a' });
  assert.deepEqual(rangeIds(order, range), ['a', 'b']);
  // Picking the start itself leaves it alone.
  assert.deepEqual(rangeIds(order, pickInRange(range, 'b')), ['b']);
  // A pick with nothing started starts there.
  assert.deepEqual(pickInRange(null, 'e'), startRange('e'));
});

test('The run is what is shown: a hidden start picks nothing, a hidden end only the start', () => {
  assert.deepEqual(rangeIds(order, null), []);
  // A filter or a switch took the start's kind away.
  assert.deepEqual(rangeIds(['a', 'c', 'e'], { start: 'b', end: 'e' }), []);
  // The end went (the tool log switched off): the start alone until another end is picked.
  assert.deepEqual(rangeIds(['a', 'b', 'c'], { start: 'b', end: 'x' }), ['b']);
  // Tools shown again: the entries between come back into the same run.
  assert.deepEqual(rangeIds(['a', 'b', 't1', 't2', 'c'], { start: 'b', end: 'c' }), [
    'b',
    't1',
    't2',
    'c',
  ]);
});

const labels: SpeakerLabels = {
  you: '나',
  name: '리뷰 담당',
  tool: '도구 사용',
  result: '작업 결과',
  other: '진행 소식',
};

test('Each bubble speaks as it is labelled on screen', () => {
  assert.equal(bubbleSpeaker('user', labels), '나');
  assert.equal(bubbleSpeaker('assistant', labels), '리뷰 담당');
  assert.equal(bubbleSpeaker('tool', labels), '도구 사용');
  assert.equal(bubbleSpeaker('result', labels), '작업 결과');
  assert.equal(bubbleSpeaker('lifecycle', labels), '진행 소식');
});

test('Copies read speaker line, Markdown source, a blank line between bubbles', () => {
  const text = formatBubbles([
    { speaker: '나', text: '  표 정리해 줘\n' },
    {
      speaker: '리뷰 담당',
      text: '정리했어요.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```',
    },
    // An image-only request adds nothing.
    { speaker: '나', text: '   ' },
    { speaker: '나', text: '고마워' },
  ]);
  assert.equal(
    text,
    [
      '나:\n표 정리해 줘',
      '리뷰 담당:\n정리했어요.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```',
      '나:\n고마워',
    ].join('\n\n'),
  );
  assert.equal(formatBubbles([]), '');
});

test('A hand-over says where it came from, then goes after the draft, never in its place', () => {
  const handed = handedText('리뷰 담당 대화에서 가져옴', '나:\n확인해 줘');
  assert.equal(handed, '리뷰 담당 대화에서 가져옴\n\n나:\n확인해 줘');
  assert.equal(addToDraft('', handed), handed);
  assert.equal(addToDraft('  \n', handed), handed);
  assert.equal(addToDraft('먼저 쓰던 글\n\n', handed), `먼저 쓰던 글\n\n${handed}`);
  // Too long for the chat box together: nothing changes (null), so nothing is lost or clipped.
  assert.equal(addToDraft('x'.repeat(REPLY_MAX - 10), handed), null);
  assert.equal(addToDraft('', 'y'.repeat(REPLY_MAX + 1)), null);
  assert.equal(addToDraft('', 'y'.repeat(REPLY_MAX))?.length, REPLY_MAX);
  assert.equal(addToDraft('ab', 'cd', 6), 'ab\n\ncd');
  assert.equal(addToDraft('ab', 'cd', 5), null);
  assert.equal(addToDraft('a', 'b', 4), 'a\n\nb');
});

test('Only colleagues whose card has a chat box take a hand-over, the office first', () => {
  const office = demoSnapshot().sessions;
  const [claude, codex, openclaw] = office;
  assert.equal(takesReplies(claude, false), true);
  assert.equal(takesReplies(codex, false), true);
  // No chat box for this tool, nor anywhere in the demo office.
  assert.equal(takesReplies(openclaw, false), false);
  assert.equal(takesReplies(claude, true), false);
  const remote = (r: Partial<NonNullable<Session['remote']>>): Session => ({
    ...claude,
    id: 'peer:1',
    remote: { send: true, stale: false, ...r } as Session['remote'],
  });
  assert.equal(takesReplies(remote({}), false), true);
  assert.equal(takesReplies(remote({ send: false }), false), false);
  assert.equal(takesReplies(remote({ stale: true }), false), false);

  const helper: Session = { ...codex, id: 'helper', attachedTo: claude.id };
  // Another run speaking for the same persona as the card's.
  const persona: Session = {
    ...codex,
    id: 'persona-now',
    resident: { sessionIds: ['persona-now', claude.id] } as Session['resident'],
  };
  const archivedCodex: Session = { ...codex, id: 'old', zone: 'archive', updatedAt: Date.now() };
  // Not the card's own colleague (nor its persona), a helper desk, or OpenClaw (no chat box):
  // the office by most recent activity (demo:1 …), then the lounge (demo:6), then the archive.
  assert.deepEqual(
    handTargets([archivedCodex, ...office, helper, persona], [claude.id], false).map((s) => s.id),
    ['demo:1', 'demo:3', 'demo:4', 'demo:5', 'demo:6', 'old'],
  );
  assert.deepEqual(handTargets(office, [claude.id], true), []);
});

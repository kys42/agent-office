import test from 'node:test';
import assert from 'node:assert/strict';
import { followDesktopSettings } from '../src/lib/desktop-settings';

test('Desktop-only settings are re-read on a change from any window and on focus', () => {
  let fire: (() => void) | undefined;
  let unsubscribed = 0;
  const api = {
    onDesktopSettings: (cb: () => void) => {
      fire = cb;
      return () => void unsubscribed++;
    },
  };
  const target = new EventTarget();
  let reads = 0;
  const stop = followDesktopSettings(api, target, () => void reads++);
  fire!();
  target.dispatchEvent(new Event('focus'));
  assert.equal(reads, 2);
  stop();
  assert.equal(unsubscribed, 1);
  target.dispatchEvent(new Event('focus'));
  assert.equal(reads, 2, 'no reads after unsubscribing');
});

test('Without the desktop bridge (web preview) only focus re-reads', () => {
  const target = new EventTarget();
  let reads = 0;
  const stop = followDesktopSettings({}, target, () => void reads++);
  target.dispatchEvent(new Event('focus'));
  stop();
  target.dispatchEvent(new Event('focus'));
  assert.equal(reads, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  READING_FONT_CHOICES,
  READING_FONT_STACK,
  TEXT_SCALE,
  TEXT_SIZE_CHOICES,
  textPrefs,
} from '../src/shared/text-prefs.js';
import { isSettingsSection, settingsCategory } from '../src/shared/settings.js';
import { OfficeService } from '../server/service.js';
import type { Snapshot } from '../src/shared/types.js';

// #246: reading-text size and font. Missing means the look from before.

test('missing text preferences are the look from before', () => {
  for (const p of [undefined, null, {}]) {
    const text = textPrefs(p);
    assert.equal(text.size, 'normal');
    assert.equal(text.font, 'system');
    assert.equal(text.scale, 1);
    // The app's own stack, unchanged: the system font first, Pretendard where there is none.
    assert.equal(text.fontStack, 'var(--font-ui)');
  }
});

test('each choice has its scale and font stack; nonsense falls back', () => {
  assert.deepEqual(TEXT_SIZE_CHOICES, ['small', 'normal', 'large', 'larger']);
  assert.deepEqual(READING_FONT_CHOICES, ['system', 'pretendard', 'mono']);
  assert.deepEqual(
    TEXT_SIZE_CHOICES.map((size) => textPrefs({ textSize: size }).scale),
    [0.92, 1, 1.12, 1.25],
  );
  assert.equal(textPrefs({ textSize: 'larger' }).scale, TEXT_SCALE.larger);
  assert.match(textPrefs({ readingFont: 'pretendard' }).fontStack, /^'Pretendard Variable'/);
  const mono = textPrefs({ readingFont: 'mono' }).fontStack;
  assert.match(mono, /^ui-monospace/);
  assert.match(mono, /D2Coding/);
  assert.match(mono, /monospace$/);
  for (const stack of Object.values(READING_FONT_STACK)) assert.doesNotMatch(stack, /Galmuri/);
  const odd = textPrefs({ textSize: 'huge' as never, readingFont: 'comic' as never });
  assert.equal(odd.size, 'normal');
  assert.equal(odd.font, 'system');
});

test('the text section deep-links into Appearance', () => {
  assert.ok(isSettingsSection('text'));
  assert.equal(settingsCategory('text'), 'appearance');
});

test('the text preferences save, round-trip, and refuse unknown values', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-text-prefs-'));
  const service = new OfficeService(path.join(temp, 'data'), temp);
  try {
    const before = service.store.preferences();
    assert.equal(before.textSize, undefined);
    assert.equal(before.readingFont, undefined);
    for (const textSize of TEXT_SIZE_CHOICES) {
      const saved = (await service.call('preferences', [{ textSize }])) as Snapshot;
      assert.equal(saved.preferences.textSize, textSize);
    }
    for (const readingFont of READING_FONT_CHOICES) {
      const saved = (await service.call('preferences', [{ readingFont }])) as Snapshot;
      assert.equal(saved.preferences.readingFont, readingFont);
    }
    for (const bad of [
      { textSize: 'huge' },
      { textSize: 1.25 },
      { readingFont: 'comic' },
      { readingFont: '' },
    ])
      await assert.rejects(service.call('preferences', [bad]), JSON.stringify(bad));
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});

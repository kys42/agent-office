import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_CATEGORIES,
  isSettingsSection,
  settingsAnchor,
  settingsCategory,
  settingsHashSection,
} from '../src/shared/settings';

test('Every settings category is also a section that opens itself', () => {
  for (const category of SETTINGS_CATEGORIES) {
    assert.ok(isSettingsSection(category));
    assert.equal(settingsCategory(category), category);
  }
});

test('Deep links keep their pre-category ids and land in the right category', () => {
  assert.equal(settingsCategory('appearance'), 'appearance');
  assert.equal(settingsCategory('office'), 'office');
  assert.equal(settingsCategory('connections'), 'connections');
  assert.equal(settingsCategory('zones'), 'spaces');
  assert.equal(settingsCategory('terminal'), 'general');
  assert.equal(settingsCategory('notifications'), 'general');
  // The old long page's "rhythm" section moved into General's privacy section.
  assert.equal(settingsCategory('rhythm'), 'general');
  assert.equal(settingsAnchor('rhythm'), 'privacy');
  assert.equal(isSettingsSection('toString'), false);
  assert.equal(isSettingsSection(undefined), false);
});

test('The settings window reads its section from the hash', () => {
  assert.equal(settingsHashSection('#settings'), undefined);
  assert.equal(settingsHashSection('#settings=office'), 'office');
  assert.equal(settingsHashSection('#settings=nope'), undefined);
  assert.equal(settingsHashSection('#card'), undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampFontSize,
  macTermKey,
  nextFontSize,
  shellQuote,
  shellQuotePaths,
  TERM_FONT,
  termShortcut,
  type KeyLike,
} from '../src/shared/term-keys.js';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  type: 'keydown',
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

test('Mac editing keys send what readline, zsh and Claude Code read as word and line moves', () => {
  assert.equal(macTermKey(key('ArrowLeft', { altKey: true })), '\x1bb');
  assert.equal(macTermKey(key('ArrowRight', { altKey: true })), '\x1bf');
  assert.equal(macTermKey(key('ArrowLeft', { metaKey: true })), '\x01');
  assert.equal(macTermKey(key('ArrowRight', { metaKey: true })), '\x05');
  assert.equal(macTermKey(key('Backspace', { altKey: true })), '\x1b\x7f');
  assert.equal(macTermKey(key('Backspace', { metaKey: true })), '\x15');
  assert.equal(macTermKey(key('Delete', { altKey: true })), '\x1bd');
});

test('other keys, key-ups, IME composition and extra modifiers stay with xterm', () => {
  for (const e of [
    key('ArrowLeft'),
    key('Backspace'),
    key('Enter', { shiftKey: true }),
    key('Enter', { altKey: true }),
    key('ArrowUp', { altKey: true }),
    key('Delete', { metaKey: true }),
    key('ArrowLeft', { altKey: true, type: 'keyup' }),
    key('ArrowLeft', { altKey: true, shiftKey: true }),
    key('ArrowLeft', { altKey: true, ctrlKey: true }),
    key('ArrowLeft', { altKey: true, metaKey: true }),
    key('ArrowLeft', { altKey: true, isComposing: true }),
    key('Backspace', { altKey: true, keyCode: 229 }),
  ])
    assert.equal(macTermKey(e), null, JSON.stringify(e));
});

test('⌘ shortcuts the terminal window keeps for itself', () => {
  assert.equal(termShortcut(key('c', { metaKey: true })), 'copy');
  assert.equal(termShortcut(key('v', { metaKey: true })), 'paste');
  assert.equal(termShortcut(key('f', { metaKey: true })), 'find');
  assert.equal(termShortcut(key('a', { metaKey: true })), 'select-all');
  assert.equal(termShortcut(key('=', { metaKey: true })), 'font-bigger');
  assert.equal(termShortcut(key('+', { metaKey: true, shiftKey: true })), 'font-bigger');
  assert.equal(termShortcut(key('-', { metaKey: true })), 'font-smaller');
  assert.equal(termShortcut(key('0', { metaKey: true })), 'font-reset');
  // A non-Latin layout still finds the physical key.
  assert.equal(termShortcut(key('ㅊ', { metaKey: true, code: 'KeyC' })), 'copy');
  assert.equal(termShortcut(key('ㄹ', { metaKey: true, code: 'KeyF' })), 'find');
  // Ctrl+C is the program's (^C), and so are plain letters.
  assert.equal(termShortcut(key('c', { ctrlKey: true })), null);
  assert.equal(termShortcut(key('c')), null);
  assert.equal(termShortcut(key('c', { metaKey: true, altKey: true })), null);
  assert.equal(termShortcut(key('c', { metaKey: true, type: 'keyup' })), null);
  assert.equal(termShortcut(key('f', { metaKey: true, isComposing: true })), null);
  assert.equal(termShortcut(key('w', { metaKey: true })), null);
});

test('font size steps stay within bounds and ⌘0 returns to the default', () => {
  assert.equal(nextFontSize(12, 'font-bigger'), 13);
  assert.equal(nextFontSize(12, 'font-smaller'), 11);
  assert.equal(nextFontSize(17, 'font-reset'), TERM_FONT.default);
  assert.equal(nextFontSize(TERM_FONT.max, 'font-bigger'), TERM_FONT.max);
  assert.equal(nextFontSize(TERM_FONT.min, 'font-smaller'), TERM_FONT.min);
  assert.equal(clampFontSize('15'), 15);
  assert.equal(clampFontSize('abc'), TERM_FONT.default);
  assert.equal(clampFontSize(1000), TERM_FONT.max);
  assert.equal(clampFontSize(12.6), 13);
});

test('dropped paths become single-quoted shell words', () => {
  assert.equal(shellQuote('/Users/me/a b.txt'), `'/Users/me/a b.txt'`);
  assert.equal(shellQuote(`/tmp/it's here`), `'/tmp/it'\\''s here'`);
  assert.equal(shellQuote('/tmp/$HOME `x` "y"'), `'/tmp/$HOME \`x\` "y"'`);
  assert.equal(shellQuotePaths(['/a', '/b c']), `'/a' '/b c' `);
  assert.equal(shellQuotePaths(['', '/한글 폴더/파일.png']), `'/한글 폴더/파일.png' `);
  assert.equal(shellQuotePaths([]), '');
  assert.equal(shellQuotePaths(['']), '');
});

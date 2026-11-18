import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { officeDataDir } from '../server/data-dir.js';
import { windowStyle, WINDOWS_TITLEBAR_HEIGHT } from '../desktop/window-style.js';

test('Windows collector and MCP share the native roaming path without overriding explicit data', () => {
  assert.equal(
    officeDataDir('win32', { APPDATA: 'D:\\Roaming' }, 'C:\\Users\\test'),
    'D:\\Roaming\\Agent Office',
  );
  assert.equal(
    officeDataDir('win32', {}, 'C:\\Users\\test'),
    'C:\\Users\\test\\AppData\\Roaming\\Agent Office',
  );
  assert.equal(officeDataDir('win32', { AGENT_OFFICE_DATA_DIR: 'D:\\Beta' }), 'D:\\Beta');
  assert.equal(
    officeDataDir('darwin', {}, '/Users/test'),
    path.join('/Users/test', 'Library', 'Application Support', 'Agent Office'),
  );
});
test('Windows keeps native controls and theme colors; macOS keeps its vibrancy and traffic lights', () => {
  const light = windowStyle('win32', false),
    dark = windowStyle('win32', true);
  assert.equal(light.titleBarStyle, 'hidden');
  assert.equal((light.titleBarOverlay as { height: number }).height, WINDOWS_TITLEBAR_HEIGHT);
  assert.notEqual(light.backgroundColor, dark.backgroundColor);
  assert.notEqual(
    (light.titleBarOverlay as { symbolColor: string }).symbolColor,
    (dark.titleBarOverlay as { symbolColor: string }).symbolColor,
  );
  assert.equal(windowStyle('darwin', false).titleBarStyle, 'hiddenInset');
  assert.equal(windowStyle('darwin', true).vibrancy, 'sidebar');
  assert.equal(windowStyle('linux', false).titleBarStyle, undefined);
});

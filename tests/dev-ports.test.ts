import test from 'node:test';
import assert from 'node:assert/strict';
import { devPorts } from '../server/dev-ports.js';

test('Dev ports default to 5173/4318 and move with AGENT_OFFICE_UI_PORT / AGENT_OFFICE_API_PORT', () => {
  assert.deepEqual(devPorts({}), { ui: 5173, api: 4318 });
  assert.deepEqual(devPorts({ AGENT_OFFICE_UI_PORT: '', AGENT_OFFICE_API_PORT: ' ' }), {
    ui: 5173,
    api: 4318,
  });
  assert.deepEqual(devPorts({ AGENT_OFFICE_UI_PORT: '5212', AGENT_OFFICE_API_PORT: '4412' }), {
    ui: 5212,
    api: 4412,
  });
  assert.deepEqual(devPorts({ AGENT_OFFICE_API_PORT: '4412' }), { ui: 5173, api: 4412 });
});

test('A bad dev port fails instead of falling back to a port another checkout may use', () => {
  for (const raw of ['abc', '0', '65536', '51.5', '-1'])
    assert.throws(() => devPorts({ AGENT_OFFICE_UI_PORT: raw }), /AGENT_OFFICE_UI_PORT/);
  assert.throws(() => devPorts({ AGENT_OFFICE_API_PORT: 'x' }), /AGENT_OFFICE_API_PORT/);
  assert.throws(
    () => devPorts({ AGENT_OFFICE_UI_PORT: '4412', AGENT_OFFICE_API_PORT: '4412' }),
    /both 4412/,
  );
});

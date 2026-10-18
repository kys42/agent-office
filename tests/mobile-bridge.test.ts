import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ServiceBridge } from '../server/bridge.js';

test('worker dispatch checks stay correlated, fail closed and allow nested snapshot reads', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ao-mobile-bridge-'));
  const file = path.join(dir, 'worker.cjs');
  await writeFile(
    file,
    `const {parentPort:p}=require('node:worker_threads'); const pending=new Map(); p.on('message',m=>{ if(m.stop){p.postMessage({stopped:true});return;} if(m.authorization!==undefined){ const id=pending.get(m.authorization);p.postMessage(m.allowed?{id,result:'sent'}:{id,error:'revoked'});return;} if(m.method==='snapshot'){p.postMessage({id:m.id,result:'visible'});return;} pending.set(m.id,m.id);p.postMessage({authorize:m.id,check:m.id}); });`,
  );
  const bridge = new ServiceBridge(file);
  try {
    assert.equal(
      await bridge.call('remote-send', [], async () => {
        assert.equal(await bridge.call('snapshot'), 'visible');
      }),
      'sent',
    );
    await assert.rejects(
      bridge.call('remote-send', [], async () => {
        throw new Error('logout');
      }),
      /revoked/,
    );
    await assert.rejects(bridge.call('remote-send'), /revoked/);
    let release!: () => void, start!: () => void;
    const started = new Promise<void>((r) => (start = r)),
      wait = new Promise<void>((r) => (release = r));
    const sending = bridge
      .call('remote-send', [], async () => {
        start();
        await wait;
      })
      .catch((e) => e);
    await started;
    const closing = bridge.close();
    release();
    await closing;
    assert.ok((await sending) instanceof Error);
  } finally {
    await bridge.close();
    await rm(dir, { recursive: true, force: true });
  }
});

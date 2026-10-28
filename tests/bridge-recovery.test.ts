import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { ServiceBridge } from '../server/bridge';

test('collector crash automatically restarts and publishes a fresh snapshot without a user request', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-recovery-'));
  const file = path.join(dir, 'worker.cjs');
  await writeFile(
    file,
    `const {parentPort}=require('node:worker_threads');
    parentPort.on('message', m => {
      if (m.stop) return parentPort.postMessage({stopped:true});
      if (m.method==='die') return process.exit(1);
      parentPort.postMessage({id:m.id,result:{epoch:'recovered',version:1}});
    });`,
  );
  const bridge = new ServiceBridge(file, undefined, [10, 20]);
  try {
    await bridge.call('snapshot');
    const snapshot = once(bridge, 'snapshot');
    await assert.rejects(bridge.call('die'));
    assert.deepEqual((await snapshot)[0], { epoch: 'recovered', version: 1 });
    assert.equal(bridge.dead, false);
  } finally {
    await bridge.close();
    await rm(dir, { recursive: true });
  }
});

test('repeated startup failures stop after the bounded restart budget; close cancels recovery', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-recovery-'));
  const file = path.join(dir, 'worker.cjs');
  const count = path.join(dir, 'starts');
  await writeFile(
    file,
    `require('node:fs').appendFileSync(${JSON.stringify(count)},'x'); process.exit(1);`,
  );
  const bridge = new ServiceBridge(file, undefined, [10, 20]);
  try {
    for (let i = 0; i < 100; i++) {
      if ((await readFile(count, 'utf8').catch(() => '')) === 'xxx') break;
      await delay(20);
    }
    await delay(100);
    assert.equal(await readFile(count, 'utf8'), 'xxx');
    await bridge.close();
    await assert.rejects(bridge.call('snapshot'));
    await delay(60);
    assert.equal(await readFile(count, 'utf8'), 'xxx');
  } finally {
    await bridge.close();
    await rm(dir, { recursive: true });
  }
});

test('a snapshot followed by another crash does not reset the automatic recovery budget', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-flapping-'));
  const file = path.join(dir, 'worker.cjs');
  const count = path.join(dir, 'starts');
  await writeFile(
    file,
    `const {parentPort}=require('node:worker_threads');
    require('node:fs').appendFileSync(${JSON.stringify(count)},'x');
    parentPort.on('message', m => {
      parentPort.postMessage({id:m.id,result:{epoch:'flap',version:1}});
      parentPort.postMessage({event:'snapshot',snapshot:{epoch:'flap',version:1}});
      setTimeout(()=>process.exit(1), 5);
    });`,
  );
  const bridge = new ServiceBridge(file, undefined, [10, 20]);
  try {
    await bridge.call('snapshot');
    for (let i = 0; i < 100; i++) {
      if ((await readFile(count, 'utf8').catch(() => '')) === 'xxx' && bridge.dead) break;
      await delay(20);
    }
    await delay(100);
    assert.equal(await readFile(count, 'utf8'), 'xxx');
    assert.equal(bridge.dead, true);
  } finally {
    await bridge.close();
    await rm(dir, { recursive: true });
  }
});

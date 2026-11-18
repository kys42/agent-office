import test from 'node:test';
import assert from 'node:assert/strict';
import { peerAgentPlist, waitForPeerUnload } from '../server/federation/launch-agent.js';

test('peer launch agent preserves exact paths, restarts at login and contains no credentials', () => {
  const config = {
    runtime: '/Applications/Agent Office.app/Contents/MacOS/Agent Office',
    bundle: '/Users/example/peer/office-peer.cjs',
    configDir: '/Users/example/A&B <peer>',
    dataDir: '/Users/example/Library/Application Support/Agent Office',
    label: 'dev.kys.agentoffice.peer-beta',
  };
  const plist = peerAgentPlist(config);
  assert.match(plist, /A&amp;B &lt;peer&gt;/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>ELECTRON_RUN_AS_NODE<\/key><string>1<\/string>/);
  assert.ok(!plist.includes('token'));
  assert.throws(() => peerAgentPlist({ ...config, label: '../../another-service' }));
  assert.throws(() => peerAgentPlist({ ...config, bundle: 'relative.cjs' }));
  assert.throws(() => peerAgentPlist({ ...config, dataDir: '/tmp/with\nnewline' }));
});

test('reinstallation waits for asynchronous launchd removal and bounds a stuck unload', async () => {
  let polls = 0,
    waits = 0;
  await waitForPeerUnload(
    () => ++polls < 4,
    async () => {
      waits++;
    },
  );
  assert.equal(polls, 4);
  assert.equal(waits, 3);
  let stuckWaits = 0;
  await assert.rejects(
    waitForPeerUnload(
      () => true,
      async () => {
        stuckWaits++;
      },
    ),
    /still unloading/,
  );
  assert.equal(stuckWaits, 100);
});

// Synthetic local-only mobile server for Android instrumentation. Never reads personal sessions.
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MobileServer } from '../server/mobile/server.js';
import { demoSnapshot } from '../src/lib/demo.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'office-android-'));
const snapshot = demoSnapshot();
const agent = snapshot.sessions.find((s) => s.provider === 'codex')!;
const now = Date.now();
agent.id = 'android-fixture';
agent.title = 'Android 검수 동료';
agent.alias = '';
agent.archived = false;
agent.updatedAt = now;
agent.events = [
  {
    id: 'old-final',
    at: now - 60000,
    kind: 'assistant',
    phase: 'final',
    text: '지난 최종응답입니다.',
    excerpt: false,
    sourceRef: 'synthetic',
  },
];
snapshot.sessions = [agent];
snapshot.preferences.privacy = false;
snapshot.preferences.excludedProjects = [];
snapshot.notices = [];
let sends = 0,
  finals = 0;
const dir = path.join(root, 'profile');
await mkdir(dir);
await writeFile(
  path.join(dir, 'mobile-web.json'),
  JSON.stringify({
    enabled: true,
    address: '127.0.0.1',
    port: 14322,
    accessCode: 'office-android-test',
  }),
  { mode: 0o600 },
);
const server = new MobileServer(dir, path.resolve('dist'), {
  snapshot: async () => snapshot,
  detail: async () => ({ ...agent, olderEvents: false }),
  targets: async (ids) =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        {
          kind: 'codex' as const,
          label: '합성 Desktop',
          status: 'desktop',
          canSend: true,
          canFocus: false,
          desktop: true,
        },
      ]),
    ),
  sendEnabled: async () => true,
  send: async (_id, _text, authorized) => {
    await authorized();
    sends++;
    return { status: 'sent', message: 'synthetic' };
  },
});
await server.restore();
const control = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/final') {
    const at = Date.now();
    finals++;
    agent.events.push({
      id: `new-final-${finals}`,
      at,
      kind: 'assistant',
      phase: 'final',
      text: '새 최종응답입니다.',
      excerpt: false,
      sourceRef: 'synthetic',
    });
    agent.updatedAt = at;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ sends, finals }));
});
control.listen(14323, '127.0.0.1');
console.log('Synthetic Android fixture listening on 127.0.0.1:14322; control 14323.');
async function close() {
  await server.close();
  control.close();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());

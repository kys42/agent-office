import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
const started = Date.now();
const app = await electron.launch({
  executablePath: 'release/Agent Office-darwin-arm64/Agent Office.app/Contents/MacOS/Agent Office',
  timeout: 30000,
});
try {
  const page = await app.firstWindow();
  const summary = await page.evaluate(async () => {
    const s = await window.office.refresh();
    return {
      total: s.sessions.length,
      providers: s.connectors.map((c) => ({
        provider: c.provider,
        state: c.state,
        count: c.count,
      })),
      counts: Object.fromEntries(
        ['claude', 'codex', 'openclaw'].map((p) => [
          p,
          s.sessions.filter((x) => x.provider === p).length,
        ]),
      ),
    };
  });
  assert.equal(summary.providers.filter((x) => x.state === 'connected').length, 3);
  assert.equal(Object.values(summary.counts).filter((x) => x > 0).length, 3);
  console.log(
    JSON.stringify({ ok: true, packagedApp: true, elapsedMs: Date.now() - started, ...summary }),
  );
} finally {
  await app.close();
}

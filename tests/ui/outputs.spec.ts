import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import type { SessionOutput } from '../../src/shared/types';

const SHOTS = process.env.OUTPUT_SHOTS;

/** Outputs of the fixture office: two projects, three teammates, one file gone, one Artifact. */
function fixture(count = 0) {
  const snapshot = demoSnapshot();
  snapshot.notices = [];
  snapshot.outputStamp = '1';
  const [a, b, c] = snapshot.sessions;
  // Two teammates in one project, a third elsewhere.
  b.project = a.project;
  c.project = 'daily-brief';
  const now = Date.now();
  const out = (
    id: string,
    s: (typeof snapshot.sessions)[number],
    name: string,
    minutesAgo: number,
    extra: Partial<SessionOutput> = {},
  ): SessionOutput => ({
    id,
    sessionId: s.id,
    kind: 'file',
    via: 'write',
    name,
    dir: `/Users/me/work/${s.project}/docs`,
    path: `/Users/me/work/${s.project}/docs/${name}`,
    ext: name.split('.').pop()!,
    createdAt: now - minutesAgo * 60_000,
    source: { provider: s.provider, project: s.project, title: s.title, alias: s.alias },
    exists: true,
    ...extra,
  });
  const outputs: SessionOutput[] = [
    out('o-report', a, '분기 보고서.md', 2),
    out('o-page', a, 'landing.html', 5, { via: 'patch' }),
    out('o-chart', b, 'chart.png', 8, { via: 'mention' }),
    out('o-gone', a, 'old-notes.md', 30, { exists: false }),
    {
      ...out('o-artifact', c, '디자인 시안', 12, {
        kind: 'link',
        via: 'artifact',
        ext: '',
        dir: '',
      }),
      path: 'https://claude.ai/code/artifact/0f6c1e2a-1111-4222-8333-944455556666',
      exists: undefined,
    },
    ...Array.from({ length: count }, (_, i) => out(`o-extra-${i}`, b, `extra-${i}.csv`, 60 + i)),
  ];
  // The oldest extras (past the first 200 rows) belong to a project of their own.
  for (const o of outputs.slice(5 + 220)) o.source = { ...o.source, project: 'old-archive' };
  return { snapshot, outputs };
}

async function open(
  page: Page,
  opts: {
    privacy?: boolean;
    empty?: boolean;
    web?: boolean;
    english?: boolean;
    count?: number;
  } = {},
) {
  const { snapshot, outputs } = fixture(opts.count);
  snapshot.preferences.privacy = !!opts.privacy;
  await page.addInitScript(
    ({ snapshot, outputs, web }) => {
      const w = window as any;
      w.fixture = snapshot;
      w.outputs = outputs;
      w.queries = [];
      w.actions = [];
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((s: any) => s.id === id)),
        visit: async () => structuredClone(w.fixture),
        artifacts: async () => [],
        search: async () => [],
        bookmarks: async () => ({ bookmarks: [], more: false, total: 0 }),
        subscribe: (cb: any) => {
          w.publish = cb;
          return () => {};
        },
        outputs: async (q: any = {}) => {
          w.queries.push(q);
          // A test may hold the answer back to look at the screen while it is read.
          if (w.hold) await w.hold;
          const all = w.outputs
            .filter((o: any) => !q.sessionIds || q.sessionIds.includes(o.sessionId))
            .filter((o: any) => !q.text || `${o.name} ${o.path}`.includes(q.text))
            // As the service: an excluded project's outputs are not listed.
            .filter(
              (o: any) =>
                !(w.fixture.preferences.excludedProjects ?? []).includes(o.source.project),
            )
            .sort((x: any, y: any) => y.createdAt - x.createdAt);
          const start = q.before ? all.findIndex((o: any) => o.id === q.before.id) + 1 : 0;
          const end = start + (q.limit ?? 50);
          return structuredClone({
            outputs: all.slice(start, end),
            total: all.length,
            more: end < all.length,
          });
        },
        ...(web
          ? {}
          : {
              outputAction: async (what: string, id: string) => {
                w.actions.push([what, id]);
                if (id === 'o-chart' && what === 'open') return 'missing';
                return what === 'copy' ? 'copied' : what === 'preview' ? 'previewed' : 'opened';
              },
            }),
        copyText: async () => {},
        terminals: async () => ({}),
      };
      localStorage.setItem('office:onboarding:v1:live', 'seen');
    },
    { snapshot, outputs: opts.empty ? [] : outputs, web: !!opts.web },
  );
  await page.goto(`/?lang=${opts.english ? 'en' : 'ko'}`);
  return { snapshot, outputs };
}

test('The Outputs tab sits beside the Memory drawer and groups by project and teammate', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { snapshot } = await open(page);
  const records = page.locator('.source-group').filter({ hasText: '기록' });
  await expect(records.locator('.source-item .source-label')).toHaveText([
    '기억 서랍',
    '산출물',
    '활동 기록',
  ]);
  await records.getByRole('button', { name: '산출물', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '산출물' }).last()).toBeVisible();
  await expect(page.locator('.results-header')).toContainText('5개의 산출물');
  const [a, b, c] = snapshot.sessions;
  // Projects in the order of their newest output, teammates likewise, outputs newest first.
  await expect(page.locator('.output-project')).toHaveText([a.project, 'daily-brief']);
  const first = page.locator('.output-group').first();
  const colleagues = first.locator('.output-colleague');
  await expect(colleagues.locator('h3')).toHaveText([
    new RegExp(a.alias || a.title),
    new RegExp(b.alias || b.title),
  ]);
  await expect(colleagues.first().locator('.output-name')).toHaveText([
    '분기 보고서.md',
    'landing.html',
    'old-notes.md',
  ]);
  await expect(colleagues.nth(1).locator('.output-name')).toHaveText(['chart.png']);
  await expect(page.locator('.output-group').nth(1).locator('.output-colleague h3')).toHaveText(
    new RegExp(c.alias || c.title),
  );
  const report = page.locator('[data-output-id="o-report"]');
  await expect(report.locator('.output-dir')).toHaveText(`~/work/${a.project}/docs`);
  await expect(report.locator('.output-via')).toHaveText('새로 만듦');
  await expect(page.locator('[data-output-id="o-page"] .output-via')).toHaveText('패치로 추가');
  await expect(page.locator('[data-output-id="o-chart"] .output-via')).toHaveText('알려 준 파일');
  // Only markdown and HTML can be previewed; a gone file can't be opened.
  await expect(report.getByRole('button', { name: /^미리보기/ })).toBeVisible();
  await expect(
    page.locator('[data-output-id="o-chart"]').getByRole('button', { name: /^미리보기/ }),
  ).toHaveCount(0);
  const gone = page.locator('[data-output-id="o-gone"]');
  await expect(gone.locator('.output-missing')).toHaveText('지금은 없어요');
  await expect(gone.getByRole('button', { name: /^열기/ })).toBeDisabled();
  await expect(gone.getByRole('button', { name: /^경로 복사/ })).toBeEnabled();
  const artifact = page.locator('[data-output-id="o-artifact"]');
  await expect(artifact.locator('.output-name')).toHaveText('디자인 시안');
  await expect(artifact.getByRole('button', { name: /^Finder|^폴더/ })).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/outputs-page-ko.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test('Each action names only the output id; results come back as toasts', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '산출물', exact: true }).click();
  const report = page.locator('[data-output-id="o-report"]');
  await report.getByRole('button', { name: /^미리보기/ }).click();
  await report.getByRole('button', { name: /^열기/ }).click();
  await report.getByRole('button', { name: /^(Finder에서 보기|폴더에서 보기)/ }).click();
  await report.getByRole('button', { name: /^경로 복사/ }).click();
  await expect(page.getByText('경로를 복사했어요')).toBeVisible();
  await page.locator('[data-output-id="o-chart"]').getByRole('button', { name: /^열기/ }).click();
  await expect(page.getByText('그 파일이 지금은 없어요')).toBeVisible();
  await page
    .locator('[data-output-id="o-artifact"]')
    .getByRole('button', { name: /^브라우저로 열기/ })
    .click();
  expect(await page.evaluate(() => (window as any).actions)).toEqual([
    ['preview', 'o-report'],
    ['open', 'o-report'],
    ['reveal', 'o-report'],
    ['copy', 'o-report'],
    ['open', 'o-chart'],
    ['open', 'o-artifact'],
  ]);
});

test('Pages load more and search narrows the list', async ({ page }) => {
  await open(page, { count: 60 });
  await page.getByRole('button', { name: '산출물', exact: true }).click();
  await expect(page.locator('.results-header')).toContainText('65개의 산출물');
  await expect(page.locator('.output-row')).toHaveCount(50);
  await page.getByRole('button', { name: '더 보기' }).click();
  await expect(page.locator('.output-row')).toHaveCount(65);
  const queries = await page.evaluate(() => (window as any).queries);
  expect(queries.at(-1).before.id).toBeTruthy();
  await page.getByRole('textbox', { name: '산출물 검색' }).fill('landing');
  await expect(page.locator('.output-row')).toHaveCount(1);
  await page.getByRole('textbox', { name: '산출물 검색' }).fill('없는이름');
  await expect(page.getByText('이 단어가 들어간 산출물이 없어요.')).toBeVisible();
});

test('A new output past 200 loaded rows keeps the loaded tail and the scroll', async ({ page }) => {
  await open(page, { count: 250 });
  await page.getByRole('button', { name: '산출물', exact: true }).click();
  const rows = page.locator('.output-row');
  await expect(rows).toHaveCount(50);
  for (const n of [100, 150, 200, 250, 255]) {
    await page.getByRole('button', { name: '더 보기' }).click();
    await expect(rows).toHaveCount(n);
  }
  await expect(page.getByRole('button', { name: '더 보기' })).toHaveCount(0);
  // Down at the oldest rows.
  const last = page.locator('[data-output-id="o-extra-249"]');
  await last.scrollIntoViewIfNeeded();
  const scroller = () =>
    page.evaluate(() => {
      let el = document.querySelector('.outputs-page') as HTMLElement | null;
      while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement;
      return el?.scrollTop ?? window.scrollY;
    });
  const before = await scroller();
  expect(before).toBeGreaterThan(1000);
  const lastTop = (await last.boundingBox())!.y;
  // Elsewhere: the first teammate records one more on top (groups keep their order), one of
  // the first 200 is gone; the stamp moves.
  await page.evaluate(() => {
    const w = window as any;
    const added = {
      ...w.outputs.find((o: any) => o.id === 'o-report'),
      id: 'o-new',
      name: 'new.md',
      ext: 'md',
      createdAt: Date.now(),
    };
    w.outputs = [added, ...w.outputs.filter((o: any) => o.id !== 'o-extra-10')];
    w.fixture.version++;
    w.fixture.outputStamp = '2';
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.locator('[data-output-id="o-new"]')).toHaveCount(1);
  await expect(page.locator('[data-output-id="o-extra-10"]')).toHaveCount(0);
  // Everything loaded further down is still there, and nothing jumped.
  await expect(rows).toHaveCount(255);
  await expect(last).toBeVisible();
  const refresh = (await page.evaluate(() => (window as any).queries)).at(-1);
  expect(refresh.limit).toBe(200);
  expect(refresh.before).toBeUndefined();
  expect(await scroller()).toBe(before);
  expect(Math.abs((await last.boundingBox())!.y - lastTop)).toBeLessThan(2);
});

test('Excluding a project past 200 loaded rows leaves none of its outputs on screen', async ({
  page,
}) => {
  await open(page, { count: 250 });
  await page.getByRole('button', { name: '산출물', exact: true }).click();
  const rows = page.locator('.output-row');
  for (const n of [100, 150, 200, 250, 255]) {
    await page.getByRole('button', { name: '더 보기' }).click();
    await expect(rows).toHaveCount(n);
  }
  // Only the loaded tail (past the first 200) is in that project.
  const archived = page.locator('[data-output-id^="o-extra-2"]').filter({
    has: page.locator('.output-name', { hasText: /^extra-2(2\d|3\d|4\d)\.csv$/ }),
  });
  await expect(archived).toHaveCount(30);
  const asked = (await page.evaluate(() => (window as any).queries.length)) as number;
  await page.evaluate(() => {
    const w = window as any;
    // The office's answer waits until the test lets it go.
    w.hold = new Promise((go) => (w.release = go));
    w.fixture.version++;
    w.fixture.preferences.excludedProjects = ['old-archive'];
    w.publish(structuredClone(w.fixture));
  });
  // The list is being read again under the new settings: not one row of the old list shows.
  await expect
    .poll(() => page.evaluate(() => (window as any).queries.length))
    .toBeGreaterThan(asked);
  await expect(archived).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  await page.evaluate(() => (window as any).release());
  await expect(page.locator('.results-header')).toContainText('225개의 산출물');
  await expect(archived).toHaveCount(0);
  // The list starts over at the first page: nothing unchecked is kept.
  await expect(rows).toHaveCount(50);
  const refresh = (await page.evaluate(() => (window as any).queries)).at(-1);
  expect(refresh.limit).toBe(50);
  expect(refresh.before).toBeUndefined();
});

test('Hidden screen content hides names, paths, teammates and every action', async ({ page }) => {
  await open(page, { privacy: true });
  await page.getByRole('button', { name: '산출물', exact: true }).click();
  await expect(page.locator('.output-row')).toHaveCount(5);
  await expect(page.locator('.output-name').first()).toHaveText('숨긴 산출물');
  await expect(page.locator('.output-dir').first()).toHaveText('경로를 숨겼어요');
  await expect(page.locator('.output-project').first()).toHaveText('프로젝트');
  await expect(page.locator('.output-colleague h3').first()).toContainText('동료');
  await expect(page.locator('.output-actions')).toHaveCount(0);
  const text = await page.locator('.outputs-page').innerText();
  expect(text).not.toContain('분기 보고서');
  expect(text).not.toContain('/Users/me');
});

test('Empty state, and the web preview lists paths without opening them', async ({ page }) => {
  await open(page, { empty: true });
  await page.getByRole('button', { name: '산출물', exact: true }).click();
  await expect(page.getByText('아직 모인 산출물이 없어요')).toBeVisible();
  await expect(page.getByText(/고치기만 한 파일과 코드는 빼요/)).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/outputs-empty-ko.png` });
});

test('The web preview only lists: no open, preview or folder actions', async ({ page }) => {
  await open(page, { web: true });
  await page.getByRole('button', { name: '산출물', exact: true }).click();
  await expect(
    page.getByText('웹 미리보기에서는 경로만 보여요. 열기는 데스크탑 앱에서 해요.'),
  ).toBeVisible();
  const report = page.locator('[data-output-id="o-report"]');
  await expect(report.getByRole('button', { name: /^열기|^미리보기|^Finder|^폴더/ })).toHaveCount(
    0,
  );
  await expect(report.getByRole('button', { name: /^경로 복사/ })).toBeVisible();
});

test('English copy', async ({ page }) => {
  await open(page, { english: true });
  await page.getByRole('button', { name: 'Outputs', exact: true }).click();
  await expect(page.locator('.results-header')).toContainText('5 outputs');
  const report = page.locator('[data-output-id="o-report"]');
  await expect(report.locator('.output-via')).toHaveText('Created');
  await expect(report.getByRole('button', { name: /^Preview/ })).toBeVisible();
  await expect(report.getByRole('button', { name: /^Copy path/ })).toBeVisible();
  // The page's own words (teammate and file names are the fixture's).
  for (const part of ['.page-head', '.results-header', '.page-note', '.output-facts'])
    for (const text of await page.locator(`.outputs-page ${part}`).allInnerTexts())
      expect(text).not.toMatch(/[가-힣]/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/outputs-page-en.png`, fullPage: true });
});

test("The work card's Details shows this teammate's outputs and leads to all of them", async ({
  page,
}) => {
  const { snapshot } = await open(page, { count: 6 });
  const b = snapshot.sessions[1];
  await page.locator(`.office-pet[data-session-id="${b.id}"]`).click();
  const card = page.locator('.inspector');
  await expect(card).toBeVisible();
  await card.getByRole('tab', { name: '작업 정보', exact: true }).click();
  const section = card.getByRole('region', { name: '이 동료가 만든 산출물' });
  await expect(section).toBeVisible();
  await expect(section.locator('.card-outputs-count')).toHaveText('7');
  await expect(section.locator('.output-row')).toHaveCount(5);
  await expect(section.locator('.output-name').first()).toHaveText('chart.png');
  const query = (await page.evaluate(() => (window as any).queries)).find((q: any) => q.sessionIds);
  expect(query.sessionIds).toContain(b.id);
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/outputs-card-ko.png` });
  await section.getByRole('button', { name: '산출물에서 7개 모두 보기' }).click();
  await expect(page.locator('.outputs-page')).toBeVisible();
});

/** The reader window (`#reader`) given one output to read. */
async function reader(
  page: Page,
  preview: { format: 'markdown' | 'html'; text: string; truncated?: boolean } | null,
  privacy = false,
) {
  const { snapshot } = fixture();
  snapshot.preferences.privacy = privacy;
  await page.addInitScript(
    ({ snapshot, preview }) => {
      const w = window as any;
      w.fixture = snapshot;
      w.reads = [];
      w.actions = [];
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        subscribe: (cb: any) => {
          w.publish = cb;
          return () => {};
        },
        bookmarkWindow: async (what: string) =>
          what === 'target'
            ? { id: 'o-report', kind: 'output' }
            : what === 'top'
              ? false
              : undefined,
        outputPreview: async (id: string) => {
          w.reads.push(id);
          // The service hides an output of an excluded project.
          if (w.hidden) return null;
          // The file as it is now (a test may edit it).
          if (w.edited) return { id, name: '분기 보고서.md', truncated: false, ...w.edited };
          return preview && { id, name: '분기 보고서.md', truncated: false, ...preview };
        },
        onReaderRefresh: (cb: () => void) => {
          w.refresh = cb;
          return () => {};
        },
        outputAction: async (what: string, id: string) => {
          w.actions.push([what, id]);
          return what === 'copy' ? 'copied' : 'opened';
        },
        bookmarkById: async () => null,
        terminals: async () => ({}),
      };
    },
    { snapshot, preview },
  );
  await page.setViewportSize({ width: 560, height: 680 });
  await page.goto('/?lang=ko#reader');
}

test('The reader window shows a markdown output with the conversation renderer', async ({
  page,
}) => {
  await reader(page, {
    format: 'markdown',
    text: '# 분기 보고서\n\n- 매출 **12%** 증가\n\n<script>window.unsafe = 1</script>\n![추적](https://example.com/t.png)',
    truncated: true,
  });
  const body = page.locator('.output-reader');
  await expect(body.locator('h1')).toHaveText('분기 보고서');
  await expect(body.locator('strong')).toHaveText('12%');
  await expect(body.locator('img, script')).toHaveCount(0);
  await expect(page.getByText('큰 파일이라 앞부분만 보여요.')).toBeVisible();
  expect(await page.evaluate(() => (window as any).unsafe)).toBeUndefined();
  await page.getByRole('button', { name: '열기' }).click();
  await page.getByRole('button', { name: '경로 복사' }).click();
  await expect(page.getByText('경로를 복사했어요')).toBeVisible();
  expect(await page.evaluate(() => (window as any).actions)).toEqual([
    ['open', 'o-report'],
    ['copy', 'o-report'],
  ]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/outputs-reader-md.png` });
});

test('An HTML output is shown in a sandbox: no scripts, no network', async ({ page }) => {
  // Chromium reports a request the CSP stops as one that failed; none may reach the network.
  const requests: string[] = [];
  const blocked: string[] = [];
  page.on('requestfinished', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:5208')) requests.push(r.url());
  });
  page.on('requestfailed', (r) => blocked.push(`${r.url()} ${r.failure()?.errorText}`));
  await reader(page, {
    format: 'html',
    text: '<h1 style="color:#0a6ee0">랜딩</h1><img src="https://example.com/pixel.png"><script>parent.unsafe = 1; document.body.dataset.ran = "yes"</script>',
  });
  const frame = page.locator('iframe.output-html');
  await expect(frame).toHaveAttribute('sandbox', '');
  const inside = page.frameLocator('iframe.output-html');
  await expect(inside.locator('h1')).toHaveText('랜딩');
  await expect(inside.locator('body')).not.toHaveAttribute('data-ran', 'yes');
  expect(await page.evaluate(() => (window as any).unsafe)).toBeUndefined();
  expect(requests).toEqual([]);
  expect(blocked).toEqual(['https://example.com/pixel.png csp']);
  await expect(page.getByText('이 미리보기에서는 스크립트와 네트워크를 막아요.')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/outputs-reader-html.png` });
});

test('The reader reads nothing while screen content is hidden', async ({ page }) => {
  await reader(page, { format: 'markdown', text: '# 비밀' }, true);
  await expect(page.getByText('화면 내용을 숨기는 동안에는 산출물을 읽지 않아요.')).toBeVisible();
  expect(await page.evaluate(() => (window as any).reads)).toEqual([]);
});

test('Previewing an open output again reads its edited file again', async ({ page }) => {
  await reader(page, { format: 'markdown', text: '# 첫 판' });
  const body = page.locator('.output-reader');
  await expect(body.locator('h1')).toHaveText('첫 판');
  // The file is edited, then Preview is pressed again: main tells the open window to reread.
  await page.evaluate(() => {
    const w = window as any;
    w.edited = { format: 'markdown', text: '# 고친 판\n\n- 새 항목' };
    w.refresh();
  });
  await expect(body.locator('h1')).toHaveText('고친 판');
  await expect(body.locator('li')).toHaveText('새 항목');
  expect(await page.evaluate(() => (window as any).reads)).toEqual(['o-report', 'o-report']);
});

test('A reader whose output is gone says so', async ({ page }) => {
  await reader(page, null);
  await expect(page.getByText('이 산출물을 읽을 수 없어요')).toBeVisible();
});

test('An open preview is checked again when settings hide its project, and hides with the screen', async ({
  page,
}) => {
  await reader(page, { format: 'markdown', text: '# 분기 보고서' });
  await expect(page.locator('.output-reader h1')).toHaveText('분기 보고서');
  // A project is excluded (from another window): what was shown goes, the service is asked again.
  await page.evaluate(() => {
    const w = window as any;
    w.hidden = true;
    w.fixture.version++;
    w.fixture.preferences.excludedProjects = [w.fixture.sessions[0].project];
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.getByText('이 산출물을 읽을 수 없어요')).toBeVisible();
  await expect(page.locator('.output-reader h1')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).reads)).toEqual(['o-report', 'o-report']);
  // Shown again, then the screen content is hidden: nothing of it stays.
  await page.evaluate(() => {
    const w = window as any;
    w.hidden = false;
    w.fixture.version++;
    w.fixture.preferences.excludedProjects = [];
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.locator('.output-reader h1')).toHaveText('분기 보고서');
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.version++;
    w.fixture.preferences.privacy = true;
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.getByText('화면 내용을 숨기는 동안에는 산출물을 읽지 않아요.')).toBeVisible();
  await expect(page.locator('.output-reader h1')).toHaveCount(0);
});

test('Settings can leave outputs off the work card', async ({ page }) => {
  const { snapshot } = await open(page);
  const a = snapshot.sessions[0];
  await page.locator(`.office-pet[data-session-id="${a.id}"]`).click();
  const card = page.locator('.inspector');
  await card.getByRole('tab', { name: '작업 정보', exact: true }).click();
  await expect(card.getByRole('region', { name: '이 동료가 만든 산출물' })).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.version++;
    w.fixture.preferences.cardOutputs = false;
    w.publish(structuredClone(w.fixture));
  });
  await expect(card.getByRole('region', { name: '이 동료가 만든 산출물' })).toHaveCount(0);
  // The switch lives under the big office's 'More' in What each screen shows.
  await page.getByRole('button', { name: '연결과 설정' }).click();
  await page.getByRole('tablist', { name: '설정 분류' }).getByRole('tab', { name: '모습' }).click();
  const views = page.locator('[data-guide-section="views"]');
  await views.getByText('자세히').last().click();
  await expect(views.getByRole('switch', { name: '업무 카드의 산출물' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
});

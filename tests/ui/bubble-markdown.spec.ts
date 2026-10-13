import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

async function fixture(page: Page, text: string, mode = '#mini=row', privacy = false, extra = 0) {
  const s = demoSnapshot();
  const colleague = s.sessions[0];
  const now = Date.now();
  Object.assign(colleague, {
    status: 'idle',
    updatedAt: now,
    events: [{ id: 'md', kind: 'assistant', text, phase: 'final', at: now }],
  });
  s.sessions = [
    colleague,
    ...s.sessions.slice(1, 1 + extra).map((s) => ({ ...s, status: 'idle' as const })),
  ];
  s.preferences.privacy = privacy;
  s.notices = [
    {
      ...s.notices![0],
      id: 'md-notice',
      eventId: 'md',
      sessionId: colleague.id,
      kind: 'reply',
      phase: 'final',
      text,
      at: now,
      receivedAt: now,
      viewedAt: null,
      seenAt: null,
      dismissedAt: null,
      resolvedAt: null,
      bootstrap: false,
      version: 'md-v1',
    },
  ];
  await page.addInitScript((s) => {
    const w = window as any;
    w.fixture = s;
    w.copied = [];
    w.opened = [];
    w.cardCalls = [];
    w.office = {
      snapshot: async () => structuredClone(s),
      subscribe: (fn: (s: unknown) => void) => {
        w.publish = () => fn(structuredClone(s));
        return () => {};
      },
      detail: async (id: string) => structuredClone(s.sessions.find((x) => x.id === id)),
      artifacts: async () => [],
      visit: async () => structuredClone(s),
      copyText: async (text: string) => {
        w.copied.push(text);
      },
      openLink: async (href: string) => {
        w.opened.push(href);
      },
      notices: async () => structuredClone(s),
      card: async (...args: unknown[]) => {
        w.cardCalls.push(args);
      },
      onCard: (cb: (target: unknown) => void) => {
        setTimeout(() => cb({ id: s.sessions[0].id, news: false }), 50);
        return () => {};
      },
    };
  }, s);
  await page.goto(`/?lang=ko${mode}`);
  const bubble = page.locator('.speech-bubble').first();
  await expect(bubble).toBeVisible();
  return bubble;
}

const lists =
  '## 진행 결과\n첫 줄이에요\n둘째 줄이에요\n\n새 문단이에요\n\n- **완료**: `검수`\n  - 안쪽 항목\n- 다음 항목\n\n3. 세 번째\n4. 네 번째\n\n- [x] 확인 완료\n- [ ] 아직 남음\n\n> 9/28~10/2 기간\n\n~~이전 내용~~';

for (const mode of ['#mini=row', '#mini=floor', '#mini', '']) {
  test(`bubble preserves lists, numbering, paragraphs and soft breaks within its bounds ${mode || 'office'}`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (/cannot be a descendant|cannot contain|hydration error/i.test(msg.text()))
        errors.push(msg.text());
    });
    const bubble = await fixture(page, lists, mode);
    const body = bubble.locator('.speech-text');
    await expect(body.locator('ul > li').first()).toContainText('완료');
    await expect(body.locator('ul ul > li')).toHaveText('안쪽 항목');
    await expect(body.locator('ol')).toHaveAttribute('start', '3');
    await expect(body.locator('ol > li')).toHaveText(['세 번째', '네 번째']);
    await expect(body.locator('ul').first()).toHaveCSS('list-style-type', 'disc');
    await expect(body.locator('ol')).toHaveCSS('list-style-type', 'decimal');
    await expect(body.locator('input')).toHaveCount(2);
    await expect(body.locator('input').first()).toBeChecked();
    await expect(body.locator('input').first()).toBeDisabled();
    await expect(body.locator('br')).toHaveCount(1);
    await expect(body.locator('blockquote')).toContainText('9/28~10/2');
    await expect(body.locator('del')).toHaveText('이전 내용');
    const closedHeight = await body.evaluate((el) => el.clientHeight);
    expect(closedHeight).toBeLessThanOrEqual(
      mode === '#mini=row' || mode === '#mini=floor' ? 75 : mode ? 45 : 30,
    );
    await bubble.getByRole('button', { name: '말풍선 전체 보기', exact: true }).click();
    await expect(bubble).toHaveClass(/is-expanded/);
    const size = await body.evaluate((el) => ({
      height: el.clientHeight,
      scroll: el.scrollHeight,
    }));
    expect(size.scroll).toBeGreaterThan(size.height);
    expect(size.height).toBeLessThanOrEqual(
      mode === '#mini=row' || mode === '#mini=floor' ? 112 : mode ? 96 : 92,
    );
    const lines = await body
      .locator('p')
      .first()
      .evaluate((el) => {
        return [...el.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())
          .map((n) => {
            const range = document.createRange();
            range.selectNodeContents(n);
            return range.getBoundingClientRect().y;
          });
      });
    expect(lines[1]).toBeGreaterThan(lines[0]);
    if (mode === '#mini=row')
      await bubble.screenshot({ path: info.outputPath('list-expanded.png') });
    await bubble.getByRole('button', { name: '말풍선 내용 전체 복사', exact: true }).click();
    expect(await page.evaluate(() => (window as any).copied)).toEqual([lists]);
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await bubble.getByRole('button', { name: '말풍선 짧게 보기', exact: true }).click();
    expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
    expect(errors).toEqual([]);
  });
}

const table =
  '| 도구 이름 | 담당 프로젝트 | 실행 상태 | 관련 링크 | 추가 정보 |\n| :--- | :---: | ---: | --- | --- |\n' +
  Array.from(
    { length: 8 },
    (_, i) =>
      `| Claude ${i} | 아주 긴 프로젝트 이름 ${i} | **진행 중** | [결과 보기](https://example.com/${i}) | 상세 설명 ${i} |`,
  ).join('\n');

test('wide tables keep their cells, scroll inside the bubble and survive updates and link clicks', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 420, height: 500 });
  const bubble = await fixture(page, table, '#mini=row', false, 3);
  const body = bubble.locator('.speech-text');
  const scroller = body.locator('.bubble-table');
  await expect(scroller.locator('th')).toHaveText([
    '도구 이름',
    '담당 프로젝트',
    '실행 상태',
    '관련 링크',
    '추가 정보',
  ]);
  await expect(scroller.locator('tbody tr')).toHaveCount(8);
  await expect(scroller.locator('th').nth(1)).toHaveCSS('text-align', 'center');
  await expect(scroller.locator('th').nth(2)).toHaveCSS('text-align', 'right');
  expect(await body.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(75);
  await bubble.getByRole('button', { name: '말풍선 전체 보기', exact: true }).click();
  expect((await bubble.boundingBox())!.width).toBeLessThanOrEqual(264);
  const width = await scroller.evaluate((el) => ({
    client: el.clientWidth,
    scroll: el.scrollWidth,
  }));
  expect(width.scroll).toBeGreaterThan(width.client);
  const desk = page.locator('.desk-station').first();
  const position = (await desk.boundingBox())!.x;
  await scroller.focus();
  await scroller.press('ArrowRight');
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  expect((await desk.boundingBox())!.x).toBeCloseTo(position, 1);
  await bubble.screenshot({ path: info.outputPath('table-expanded.png') });
  await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  const offset = await scroller.evaluate((el) => el.scrollLeft);
  await page.evaluate(() => (window as any).publish());
  expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(offset);
  await scroller.locator('a').first().click();
  expect(await page.evaluate(() => (window as any).opened)).toEqual(['https://example.com/0']);
  await expect(bubble).toHaveClass(/is-expanded/);
  await bubble.getByRole('button', { name: '말풍선 내용 전체 복사', exact: true }).click();
  expect(await page.evaluate(() => (window as any).copied)).toEqual([table]);
});

test('a table also stays intact in the colleague popup', async ({ page }) => {
  const bubble = await fixture(page, table);
  await bubble.getByRole('button', { name: '말풍선 전체 보기', exact: true }).click();
  await bubble.locator('.bubble-popup').click();
  expect((await page.evaluate(() => (window as any).cardCalls))[0][0]).toBe('open');
  await page.goto('/?lang=ko&card-test=1#card');
  const popup = page.locator('.dock-card');
  await expect(popup).toBeVisible();
  const message = popup.locator('.message-text').filter({ has: page.locator('table') });
  const expand = popup.locator('.message-expand');
  await expect(expand).toBeVisible();
  await expand.click();
  await expect(message.locator('tbody tr')).toHaveCount(8);
  await expect(message.locator('th')).toHaveCount(5);
});

test('private bubbles hide original markdown', async ({ page }) => {
  const bubble = await fixture(page, table, '#mini=row', true);
  await expect(bubble.locator('table')).toHaveCount(0);
  await expect(bubble).not.toContainText('담당 프로젝트');
});

test('raw HTML, images and unsafe links do not become active inside structured messages', async ({
  page,
}) => {
  const bubble = await fixture(
    page,
    '- [위험 링크](javascript:alert(1))\n- ![이미지](https://example.com/image.png)\n\n<script>window.attacked=true</script>\n\n**안전한 글**',
  );
  await expect(bubble.locator('a, img, script')).toHaveCount(0);
  await expect(bubble.locator('strong')).toHaveText('안전한 글');
  expect(await page.evaluate(() => (window as any).attacked)).toBeUndefined();
});

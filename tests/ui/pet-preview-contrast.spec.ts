import { test, expect, type Locator } from '@playwright/test';
import './korean';

/**
 * WCAG contrast of an element's text against what is drawn under it: its own background (when
 * it has one) laid over the preview stage's backdrop.
 */
async function contrast(el: Locator, stage: Locator) {
  const under = await stage.elementHandle();
  return el.evaluate((node, stageNode) => {
    const parse = (c: string) => {
      const n = c.match(/[\d.]+/g)!.map(Number);
      return { r: n[0], g: n[1], b: n[2], a: n[3] ?? 1 };
    };
    const over = (top: ReturnType<typeof parse>, under: ReturnType<typeof parse>) => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    });
    const lum = (c: ReturnType<typeof parse>) => {
      const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
    };
    const base = parse(getComputedStyle(stageNode as Element).backgroundColor);
    const own = parse(getComputedStyle(node).backgroundColor);
    const bg = over(own, base);
    const fg = over(parse(getComputedStyle(node).color), bg);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return { ratio: (hi + 0.05) / (lo + 0.05), bg: `${bg.r},${bg.g},${bg.b}` };
  }, under);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the pet customizer preview reads in the ${colorScheme} appearance`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto('/?demo');
    await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
    await page.getByRole('tab', { name: '모습' }).click();
    await page.getByRole('button', { name: 'Claude 캐릭터 꾸미기' }).click();
    const dialog = page.getByRole('dialog', { name: 'Claude 기본 캐릭터' });
    const stage = dialog.locator('.pet-preview');
    await expect(stage).toBeVisible();
    // The name, its description, the scope note and every chip (moods, walk, pat, praise).
    for (const el of [
      stage.locator('h3'),
      stage.locator('> p').first(),
      stage.locator('.pet-scope-note'),
    ])
      expect((await contrast(el, stage)).ratio).toBeGreaterThanOrEqual(4.5);
    const chips = stage.locator('.pet-preview-moods button');
    expect(await chips.count()).toBeGreaterThanOrEqual(11);
    for (const chip of await chips.all())
      expect((await contrast(chip, stage)).ratio).toBeGreaterThanOrEqual(4.5);
    expect((await contrast(stage.locator('.pet-joy-hint'), stage)).ratio).toBeGreaterThanOrEqual(3);
    // The mood being shown stands apart from the others.
    const moods = stage.getByRole('group', { name: '동작 미리보기' });
    const pressed = moods.locator('button[aria-pressed="true"]');
    await expect(pressed).toHaveCount(1);
    const plain = moods.locator('button[aria-pressed="false"]').first();
    const look = (l: Locator) =>
      l.evaluate((n) => {
        const s = getComputedStyle(n);
        return [s.color, s.backgroundColor, s.borderTopColor].join(' | ');
      });
    const [on, off] = [await look(pressed), await look(plain)];
    expect(on.split(' | ')[0]).not.toBe(off.split(' | ')[0]);
    expect(on.split(' | ')[1]).not.toBe(off.split(' | ')[1]);
    await stage.screenshot({ path: `.local/pet-preview-${colorScheme}.png` });
  });
}

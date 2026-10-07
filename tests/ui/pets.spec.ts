import { test, expect } from '@playwright/test';

test('Provider customization saves across reload and matches office, roster, lounge and dock modes', async ({
  page,
}) => {
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().includes('/sprites/'))
      failures.push(response.url());
  });
  await page.goto('/?demo');
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page.getByRole('button', { name: 'Claude 캐릭터 꾸미기' }).click();
  const dialog = page.getByRole('dialog', { name: 'Claude 기본 캐릭터' });
  await dialog.getByRole('button', { name: '캐릭터 말랑', exact: true }).click();
  await dialog.getByRole('button', { name: '색상 민트' }).click();
  await dialog
    .getByRole('group', { name: '동작 미리보기' })
    .getByRole('button', { name: '불러요', exact: true })
    .click();
  await expect
    .poll(() =>
      dialog
        .locator('.pet-preview .sprite-window')
        .evaluate((element) =>
          [...element.querySelectorAll('.sprite')].every(
            (layer) => Number(layer.getAnimations()[0]?.currentTime ?? 0) > 100,
          ),
        ),
    )
    .toBe(true);
  await dialog.getByRole('button', { name: '장식 왕관' }).click();
  await expect
    .poll(() =>
      dialog.locator('.pet-preview .sprite-window').evaluate((element) => {
        const [body, decoration] = [...element.querySelectorAll('.sprite')];
        return (
          body.getAnimations()[0]?.startTime === decoration.getAnimations()[0]?.startTime &&
          getComputedStyle(body).backgroundPositionX ===
            getComputedStyle(decoration).backgroundPositionX
        );
      }),
    )
    .toBe(true);
  for (const name of [
    '일하는 중',
    '생각 중',
    '불러요',
    '응답 완료',
    '확인 필요',
    '퇴근',
    '보관됨',
    '걷기',
  ]) {
    await dialog
      .getByRole('group', { name: '동작 미리보기' })
      .getByRole('button', { name, exact: true })
      .click();
    await expect(dialog.locator('.pet-preview .sprite-decoration')).toHaveCount(1);
  }
  await dialog.getByRole('button', { name: '이 모습으로 저장' }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.office-pet [data-asset-id="pet.slime.v1"]')).toHaveCount(3);
  await expect(page.locator('.session-row [data-asset-id="pet.slime.v1"]')).toHaveCount(3);
  await expect(
    page.locator('.office-pet [data-pet-color="mint"][data-pet-accessory="crown"]'),
  ).toHaveCount(3);
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page.getByRole('button', { name: 'Codex 캐릭터 꾸미기' }).click();
  await page.getByRole('button', { name: '캐릭터 돌돌', exact: true }).click();
  await page.getByRole('button', { name: '이 모습으로 저장' }).click();
  await page.getByRole('button', { name: '우리 사무실', exact: true }).click();
  await page.getByRole('tab', { name: /대기 라운지/ }).click();
  await expect(page.locator('.rest-pet [data-asset-id="pet.pebble.v1"]')).toHaveCount(1);
  for (const mode of ['row', 'floor']) {
    await page.goto(`/?demo&dock=${mode}#mini=${mode}`);
    await expect(page.locator('.desk-row .office-pet [data-asset-id="pet.slime.v1"]')).toHaveCount(
      3,
    );
    await expect(
      page.locator('.desk-row [data-pet-color="mint"][data-pet-accessory="crown"]'),
    ).toHaveCount(3);
  }
  await page.goto('/?demo&dock=pet#mini');
  await expect(page.locator('.dock-pet-body .sprite-window')).toHaveCount(1);
  const lead = page.locator('.dock-pet-body .sprite-window');
  if ((await lead.getAttribute('data-asset-id')) === 'pet.slime.v1') {
    await expect(lead).toHaveAttribute('data-pet-color', 'mint');
    await expect(lead).toHaveAttribute('data-pet-accessory', 'crown');
  }
  expect(failures).toEqual([]);
});

test('One colleague keeps an individual look while defaults change, and reset resumes inheritance', async ({
  page,
}) => {
  await page.goto('/?demo');
  await page.locator('.session-row').filter({ hasText: '코코' }).click();
  await page.getByRole('button', { name: '이 동료 꾸미기' }).click();
  const dialog = page.getByRole('dialog', { name: '이 동료 꾸미기' });
  await dialog.getByRole('button', { name: '캐릭터 코딩냥', exact: true }).click();
  await dialog.getByRole('button', { name: '색상 복숭아' }).click();
  await dialog.getByRole('button', { name: '장식 베레모' }).click();
  await dialog.getByRole('button', { name: '이 모습으로 저장' }).click();
  await expect(page.locator('.profile-avatar [data-asset-id="pet.devcat.v1"]')).toHaveCount(1);
  await page.getByRole('button', { name: '업무 카드 닫기' }).click();
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page.getByRole('button', { name: 'Claude 캐릭터 꾸미기' }).click();
  await page.getByRole('button', { name: '캐릭터 몽실', exact: true }).click();
  await page.getByRole('button', { name: '색상 버터' }).click();
  await page.getByRole('button', { name: '장식 새싹' }).click();
  await page.getByRole('button', { name: '이 모습으로 저장' }).click();
  await page.getByRole('button', { name: '우리 사무실', exact: true }).click();
  await expect(page.locator('.office-pet [data-asset-id="pet.devcat.v1"]')).toHaveCount(1);
  await expect(page.locator('.office-pet [data-asset-id="pet.cloud.v1"]')).toHaveCount(2);
  await page.locator('.session-row').filter({ hasText: '코코' }).click();
  await page.getByRole('button', { name: '이 동료 꾸미기' }).click();
  await dialog.getByRole('button', { name: '도구 기본 모습으로' }).click();
  await expect(
    page.locator(
      '.profile-avatar [data-asset-id="pet.cloud.v1"][data-pet-color="butter"][data-pet-accessory="sprout"]',
    ),
  ).toHaveCount(1);
});

test('Cancel leaves saved appearance intact and the editor works at phone width with reduced motion', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?demo');
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  const trigger = page.getByRole('button', { name: 'OpenClaw 캐릭터 꾸미기' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'OpenClaw 기본 캐릭터' });
  await dialog.getByRole('button', { name: '캐릭터 삐코', exact: true }).click();
  await dialog.getByRole('button', { name: '색상 라벤더' }).click();
  await dialog.getByRole('button', { name: '장식 안경' }).click();
  const preview = dialog.locator('.pet-preview .sprite').first();
  expect(await preview.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(trigger.locator('[data-asset-id="pet.openclaw.v1"]')).toHaveCount(1);
  await trigger.click();
  await dialog.getByRole('button', { name: '캐릭터 삐코', exact: true }).click();
  await dialog.getByRole('button', { name: '이 모습으로 저장' }).click();
  await expect(trigger.locator('[data-asset-id="pet.retrobot.v1"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

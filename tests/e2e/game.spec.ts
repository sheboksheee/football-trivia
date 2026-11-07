import { expect, test, type Browser, type Page } from '@playwright/test';

async function player(browser: Browser, width = 390, height = 844) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  return ctx.newPage();
}

async function createRoom(page: Page, name: string) {
  await page.goto('/#/create');
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.locator('.bigcode')).toBeVisible();
  return (await page.locator('.bigcode').textContent())!.trim();
}

async function join(
  page: Page,
  code: string,
  name: string,
  role: 'Player' | 'Judge' | 'Spectator' = 'Player',
) {
  await page.goto(`/#/join/${code}`);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: role, exact: true }).click();
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.locator('.bigcode')).toBeVisible();
}

test('two players complete a Higher or Lower match; spectator never sees hidden values', async ({
  browser,
}) => {
  const host = await player(browser);
  const guest = await player(browser, 1280, 860);
  const spec = await player(browser, 768, 1024);
  const code = await createRoom(host, 'Amira');
  await join(guest, code, 'Bruno');
  await join(spec, code, 'Watcher', 'Spectator');
  await expect(host.getByText('1 spectators')).toBeVisible();
  await host.getByRole('button', { name: /Single mode/ }).click();
  await host.locator('.modecard', { hasText: 'Higher or Lower' }).click();
  await host.getByRole('button', { name: 'Save playlist' }).click();
  await host.getByRole('button', { name: "I'm ready" }).click();
  await guest.getByRole('button', { name: "I'm ready" }).click();
  await host.getByRole('button', { name: 'Kick off' }).click();
  for (let q = 0; q < 5; q++) {
    await expect(host.getByRole('button', { name: /B is higher/ })).toBeEnabled({ timeout: 15_000 });
    // While the question is live, the spectator sees "?" for B.
    await expect(spec.locator('.statcard').nth(1).locator('.big')).toHaveText('?');
    await host.getByRole('button', { name: /B is higher/ }).click();
    await guest.getByRole('button', { name: /B is lower/ }).click();
    await expect(host.getByText('Appeal this result')).toBeVisible();
  }
  await expect(host.getByText(/Champion/)).toBeVisible({ timeout: 30_000 });
  await expect(spec.getByText(/Champion/)).toBeVisible();
  await expect(guest.getByText('Mode breakdown')).toBeVisible();
});

test('host can reload and resume the same seat (rotating token)', async ({ browser }) => {
  const host = await player(browser);
  const code = await createRoom(host, 'Reloader');
  await host.reload();
  await expect(host.locator('.bigcode')).toHaveText(code);
  await expect(host.getByText('HOST')).toBeVisible();
});

test('Arabic RTL at 360px: dir switches and no horizontal page scroll', async ({ browser }) => {
  const page = await player(browser, 360, 740);
  await page.goto('/');
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('button', { name: 'إنشاء غرفة' })).toBeVisible();
  for (const route of ['/', '/#/how', '/#/join']) {
    await page.goto(route);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});

test('keyboard-only room creation and reduced motion', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto('/#/create');
  await page.getByLabel('Your name').focus();
  await page.keyboard.type('Keys');
  await page.keyboard.press('Enter');
  await expect(page.locator('.bigcode')).toBeVisible();
  const dur = await page.evaluate(() => getComputedStyle(document.querySelector('.btn')!).transitionDuration);
  expect(dur.split(',').every((d) => parseFloat(d) === 0)).toBe(true);
  // Every visible button meets the 44px minimum tap target.
  const small = await page.$$eval('button', (bs) =>
    bs.filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.textContent),
  );
  expect(small).toEqual([]);
});

test('admin studio: token required, quarantine and rights-blocked items visible', async ({ page }) => {
  await page.goto('/#/admin');
  await page.getByLabel('Admin token').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Admin token required')).toBeVisible();
  await page.getByLabel('Admin token').fill('e2e-admin-token');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Source conflicts')).toBeVisible();
  await expect(page.locator('.list-item').first()).toBeVisible();
  await page.getByLabel('Status').selectOption('BLOCKED_RIGHTS');
  await page.locator('.list-item').first().click();
  await expect(page.getByText('Blocked until the source license is approved')).toBeVisible();
});

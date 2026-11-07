import { expect, test, type Browser, type Page } from '@playwright/test';

async function player(browser: Browser, width = 390, height = 844, locale: 'en' | 'ar' = 'en') {
  const ctx = await browser.newContext({ viewport: { width, height } });
  // Arabic is the app default; English-language tests pin the locale explicitly.
  await ctx.addInitScript((l) => localStorage.setItem('ft.locale', l), locale);
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

test('Egyptian Arabic is the default; RTL at 360px with no horizontal scroll; toggle to English', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('button', { name: 'اعمل أوضة' })).toBeVisible();
  // Mode names are shown in Egyptian Arabic
  for (const name of ['أكتر ولا أقل؟', 'خناقة الجرس', 'المندس', 'يا تصيب يا تخيب', 'التوب ٢٥'])
    await expect(page.getByText(name).first()).toBeVisible();
  for (const route of ['/', '/#/how', '/#/join', '/#/create']) {
    await page.goto(route);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
  await page.goto('/');
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('button', { name: 'Create room' })).toBeVisible();
});

test('a full Arabic game on phone + laptop', async ({ browser }) => {
  const laptop = await player(browser, 1440, 900, 'ar');
  const phone = await player(browser, 390, 844, 'ar');
  await laptop.goto('/#/create');
  await laptop.getByLabel('اسمك إيه؟').fill('شيكابالا');
  await laptop.getByRole('button', { name: 'يلا نعمل الأوضة' }).click();
  await expect(laptop.locator('.bigcode')).toBeVisible();
  const code = (await laptop.locator('.bigcode').textContent())!.trim();
  await phone.goto(`/#/join/${code}`);
  await phone.getByLabel('اسمك إيه؟').fill('أبو تريكة');
  await phone.getByRole('button', { name: 'دخّلني' }).click();
  await expect(phone.locator('.bigcode')).toBeVisible();
  await laptop.getByRole('button', { name: /لعبة واحدة/ }).click();
  await laptop.locator('.modecard', { hasText: 'أكتر ولا أقل؟' }).click();
  await laptop.getByRole('button', { name: 'احفظ البرنامج' }).click();
  await laptop.getByRole('button', { name: /أنا جاهز/ }).click();
  await phone.getByRole('button', { name: /أنا جاهز/ }).click();
  await laptop.getByRole('button', { name: 'صفّارة البداية' }).click();
  for (let q = 0; q < 5; q++) {
    await expect(laptop.getByRole('button', { name: /B أكتر/ })).toBeEnabled({ timeout: 15_000 });
    await laptop.getByRole('button', { name: /B أكتر/ }).click();
    await phone.getByRole('button', { name: /B أقل/ }).click();
    await expect(laptop.getByText(/اعترض/).first()).toBeVisible();
  }
  await expect(phone.getByText('نقط كل لعبة')).toBeVisible({ timeout: 30_000 });
  await expect(laptop.getByText(/البطل|أبطال بالمشاركة/).first()).toBeVisible();
});

test('keyboard-only room creation and reduced motion', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => localStorage.setItem('ft.locale', 'en'));
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
  await page.addInitScript(() => localStorage.setItem('ft.locale', 'en'));
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

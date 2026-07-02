import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addDevice(page: Page, type: string, x = 400, y = 300): Promise<string> {
  return page.evaluate(({ type, x, y }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(type, x, y).id;
  }, { type, x, y });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(250);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string | RegExp, timeout = 8_000): Promise<void> {
  await expect.poll(
    async () => {
      const t = await modalText(page);
      return typeof needle === 'string' ? t.includes(needle) : needle.test(t);
    },
    { timeout },
  ).toBe(true);
}

async function ctrlC(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"]').click();
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(400);
}

async function promptInputVisible(page: Page): Promise<boolean> {
  const inputs = await page.locator('[data-testid="terminal-modal"] input[type="text"]').all();
  for (const inp of inputs) {
    const box = await inp.boundingBox();
    if (box && box.width > 1 && box.height > 1) return true;
  }
  return false;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.afterEach(async ({ page }) => { await closeTerminal(page); });

test.describe('Linux — dstat through the real UI', () => {
  test('dstat --version prints the version line', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'dstat --version');
    await waitForText(page, 'pcp-dstat');
  });

  test('dstat 1 2 prints the column header + 2 data rows then unlocks', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'dstat 1 2');
    await waitForText(page, '----total-cpu-usage----', 6_000);
    await waitForText(page, 'usr sys idl wai stl');
    await expect.poll(
      async () => (await modalText(page)).split('\n').filter((l) => /^\s*\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(l)).length,
      { timeout: 8_000 },
    ).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => promptInputVisible(page), { timeout: 5_000 }).toBe(true);
  });

  test('dstat -c -m only shows CPU + memory columns', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'dstat -c -m 1 1');
    await waitForText(page, '----total-cpu-usage----', 6_000);
    await waitForText(page, '------memory-usage-----');
    const text = await modalText(page);
    expect(text).not.toContain('-net/total-');
    expect(text).not.toContain('---paging--');
    expect(text).not.toContain(' int   csw');
  });

  test('dstat (live) repaints rows and unlocks the prompt on Ctrl+C', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'dstat');
    await waitForText(page, '----total-cpu-usage----', 6_000);
    expect(await promptInputVisible(page)).toBe(false);

    await expect.poll(
      async () => (await modalText(page)).split('\n').filter((l) => /^\s*\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(l)).length,
      { timeout: 6_000 },
    ).toBeGreaterThanOrEqual(2);

    await ctrlC(page);
    await waitForText(page, '^C');
    expect(await promptInputVisible(page)).toBe(true);
  });
});

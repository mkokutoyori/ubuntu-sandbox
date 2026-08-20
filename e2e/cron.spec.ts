import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}
async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(t, 400, 300).id;
  }, type);
}
async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}
async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(400);
}
async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

test.beforeEach(async ({ page }) => { await page.goto('/'); await waitForStore(page); });

test('crontab install + list round-trips through the UI', async ({ page }) => {
  const id = await addDevice(page, 'linux-pc');
  await openTerminal(page, id);
  await typeCmd(page, 'echo "*/2 * * * * /bin/echo hi" | crontab -');
  await typeCmd(page, 'crontab -l');
  expect(await modalText(page)).toContain('*/2 * * * * /bin/echo hi');
});

test('crontab -l reports no crontab after -r', async ({ page }) => {
  const id = await addDevice(page, 'linux-pc');
  await openTerminal(page, id);
  await typeCmd(page, 'echo "0 0 * * * /bin/true" | crontab -');
  await typeCmd(page, 'crontab -r');
  await typeCmd(page, 'crontab -l');
  expect(await modalText(page)).toContain('no crontab for');
});

test('crontab -e opens the nano editor seeded with a template', async ({ page }) => {
  const id = await addDevice(page, 'linux-pc');
  await openTerminal(page, id);
  await typeCmd(page, 'crontab -e');
  await page.waitForTimeout(500);
  const text = await page.locator('body').innerText();
  expect(text).toContain('GNU nano');
  expect(text).toMatch(/crontab\.\d+/);
});

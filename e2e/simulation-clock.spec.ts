import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 30_000 });
}

async function addDevice(page: Page, type: string, x: number, y: number): Promise<string> {
  return page.evaluate(({ type, x, y }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(type, x, y).id;
  }, { type, x, y });
}

async function pressClock(page: Page, testId: string): Promise<void> {
  await page.evaluate(() => (document.querySelector('button[title="Settings"]') as HTMLElement).click());
  await page.locator('[data-testid="settings-dialog"]').waitFor({ state: 'visible', timeout: 15_000 });
  await page.evaluate((id) => (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).click(), testId);
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="settings-dialog"]').waitFor({ state: 'hidden', timeout: 15_000 });
}

async function run(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
}

test('the settings window advances every machine and the terminal sees it', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForStore(page);
  const id = await addDevice(page, 'linux-pc', 300, 300);
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 15_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 15_000 });

  await run(page, 'date +%H');
  await page.waitForTimeout(500);
  const hourBefore = Number(((await page.locator('[data-testid="terminal-modal"]').innerText()).match(/\n(\d\d)\s*\n/) ?? [])[1]);

  await pressClock(page, 'simulation-jump-3600000');
  await page.waitForTimeout(800);
  await run(page, 'date +%H');
  await page.waitForTimeout(500);
  const hours = [...(await page.locator('[data-testid="terminal-modal"]').innerText()).matchAll(/\n(\d\d)\s*(?=\n)/g)].map((m) => Number(m[1]));
  expect(hours.length).toBeGreaterThanOrEqual(2);
  expect((hours[hours.length - 1] - hours[0] + 24) % 24).toBe(1);
  expect(Number.isNaN(hourBefore)).toBe(false);
});

test('a sleeping command completes under the running clock', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForStore(page);
  const id = await addDevice(page, 'linux-pc', 300, 300);
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 15_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 15_000 });
  await run(page, 'sleep 2; echo woke-up');
  await expect(page.locator('[data-testid="terminal-modal"]')).toContainText('woke-up', { timeout: 10_000 });
});

test('a paused clock freezes the date of the machine until time resumes', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForStore(page);
  const id = await addDevice(page, 'linux-pc', 300, 300);
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 15_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 15_000 });
  const epochs = async (): Promise<number[]> =>
    [...(await page.locator('[data-testid="terminal-modal"]').innerText()).matchAll(/\n(\d{10})\s*(?=\n)/g)].map((m) => Number(m[1]));
  await pressClock(page, 'simulation-toggle');
  await run(page, 'date +%s');
  await page.waitForTimeout(3_000);
  await run(page, 'date +%s');
  await page.waitForTimeout(500);
  const frozen = await epochs();
  expect(frozen.length).toBe(2);
  expect(frozen[1]).toBe(frozen[0]);
  await pressClock(page, 'simulation-toggle');
  await page.waitForTimeout(2_500);
  await run(page, 'date +%s');
  await page.waitForTimeout(500);
  const resumed = await epochs();
  expect(resumed.length).toBe(3);
  expect(resumed[2] - resumed[0]).toBeGreaterThanOrEqual(2);
});

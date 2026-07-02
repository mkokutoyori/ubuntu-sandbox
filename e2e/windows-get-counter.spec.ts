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

async function enterPowerShell(page: Page): Promise<void> {
  await typeCmd(page, 'powershell');
  await page.waitForTimeout(500);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.afterEach(async ({ page }) => { await closeTerminal(page); });

test.describe('Windows — PS Get-Counter through the real UI', () => {
  test('one-shot prints the default counter set with Timestamp + samples', async ({ page }) => {
    const id = await addDevice(page, 'windows-pc');
    await openTerminal(page, id);
    await enterPowerShell(page);
    await typeCmd(page, 'Get-Counter');
    await waitForText(page, 'Timestamp                 CounterSamples');
    await waitForText(page, /\\processor\(_total\)\\% processor time/);
    await waitForText(page, /\\memory\\available mbytes/);
  });

  test('-ListSet memory renders the catalog block', async ({ page }) => {
    const id = await addDevice(page, 'windows-pc');
    await openTerminal(page, id);
    await enterPowerShell(page);
    await typeCmd(page, 'Get-Counter -ListSet memory');
    await waitForText(page, 'CounterSetName     : memory');
    await waitForText(page, /\\Memory\\Available MBytes/);
  });

  test('-MaxSamples 2 -SampleInterval 1 streams two snapshots then unlocks', async ({ page }) => {
    const id = await addDevice(page, 'windows-pc');
    await openTerminal(page, id);
    await enterPowerShell(page);
    await typeCmd(page, 'Get-Counter -MaxSamples 2 -SampleInterval 1');
    await expect.poll(
      async () => (await modalText(page)).split('Timestamp                 CounterSamples').length - 1,
      { timeout: 6_000 },
    ).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => promptInputVisible(page), { timeout: 5_000 }).toBe(true);
  });

  test('-Continuous streams until Ctrl+C and unlocks the prompt', async ({ page }) => {
    const id = await addDevice(page, 'windows-pc');
    await openTerminal(page, id);
    await enterPowerShell(page);
    await typeCmd(page, 'Get-Counter -Continuous -SampleInterval 1');
    await waitForText(page, /\\processor\(_total\)\\% processor time/, 6_000);
    expect(await promptInputVisible(page)).toBe(false);

    await ctrlC(page);
    await waitForText(page, '^C');
    expect(await promptInputVisible(page)).toBe(true);
  });
});

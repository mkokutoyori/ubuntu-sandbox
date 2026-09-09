import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 45_000 });
}

async function addDevice(page: Page, type: string, x: number, y: number): Promise<string> {
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
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForTimeout(200);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(300);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

test.describe('la machine nomme un seul noyau', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('uname, motd, last et dmesg le nomment pareil', async ({ page }) => {
    test.slow();
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'uname -r');
    const noyau = (await modalText(page)).split('\n').find((l) => /^5\.\d+/.test(l.trim()))?.trim() ?? '';
    expect(noyau).toMatch(/^\d+\.\d+\.\d+-\d+-generic$/);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'cat /etc/motd');
    expect(await modalText(page)).toContain(noyau);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'last');
    expect(await modalText(page)).toContain(noyau);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'dmesg | head -1');
    expect(await modalText(page)).toContain(`Linux version ${noyau}`);

    await closeTerminal(page);
  });

  test('le chemin que modinfo nomme existe vraiment', async ({ page }) => {
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'ls /lib/modules/$(uname -r)/');
    expect(await modalText(page)).toContain('kernel');

    await closeTerminal(page);
  });
});

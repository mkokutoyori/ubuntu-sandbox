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

test.describe('la machine annonce une seule charge', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('uptime, top et /proc/loadavg s accordent', async ({ page }) => {
    // Le premier cas du fichier porte le demarrage a froid du serveur de
    // developpement, qui depasse le budget par defaut sur cette machine.
    test.slow();
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'uptime');
    expect(await modalText(page)).toContain('load average: 0.00, 0.00, 0.00');

    await typeCmd(page, 'clear');
    await typeCmd(page, 'top -b -n 1');
    expect(await modalText(page)).toContain('load average: 0.00, 0.00, 0.00');

    await typeCmd(page, 'clear');
    await typeCmd(page, 'cat /proc/loadavg');
    expect(await modalText(page)).toMatch(/0\.00 0\.00 0\.00 \d+\/\d+ \d+/);

    await closeTerminal(page);
  });

  test('/proc/self mene au processus courant', async ({ page }) => {
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'cat /proc/self/status');
    expect(await modalText(page)).toContain('Name:');

    await typeCmd(page, 'clear');
    await typeCmd(page, 'cat /proc/stat');
    const stat = await modalText(page);
    expect(stat).toMatch(/^cpu {2}0 0 0 \d+/m);
    expect(stat).toMatch(/^procs_running \d+/m);

    await closeTerminal(page);
  });
});

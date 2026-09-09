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
  await page.waitForTimeout(400);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

test.describe('une machine a un seul inventaire de processus', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('la ligne Tasks de top s additionne', async ({ page }) => {
    test.slow();
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'top -b -n 1 | head -2');
    const entete = await modalText(page);
    const m = /Tasks:\s*(\d+) total,\s*(\d+) running,\s*(\d+) sleeping,\s*(\d+) stopped,\s*(\d+) zombie/
      .exec(entete);
    expect(m).not.toBeNull();
    const [total, running, sleeping, stopped, zombie] = m!.slice(1).map(Number);
    expect(running + sleeping + stopped + zombie).toBe(total);

    await closeTerminal(page);
  });

  test('top et ps rendent la meme memoire, en kibioctets', async ({ page }) => {
    test.slow();
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'top -b -n 1 | grep " 1 root"');
    expect(await modalText(page)).toMatch(/\s169000\s+13000\s+0\sS/);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'ps aux | grep sbin/init');
    expect(await modalText(page)).toMatch(/\s169000\s+13000\s/);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'top -b -n 1 | grep kthreadd');
    expect(await modalText(page)).toMatch(/\s0\s+0\s+0\sS/);

    await closeTerminal(page);
  });

  test('ps -ef ecrit TIME en HH:MM:SS et ps aux en M:SS', async ({ page }) => {
    test.slow();
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'ps -ef | grep sbin/init');
    expect(await modalText(page)).toMatch(/\s00:00:00\s+\/sbin\/init/);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'ps aux | grep sbin/init');
    expect(await modalText(page)).toMatch(/\s0:00\s+\/sbin\/init/);

    await closeTerminal(page);
  });
});

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

test.describe('les compteurs d une interface ont une seule source', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('/sys porte ce qu ethtool compte', async ({ page }) => {
    test.slow();
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'cat /sys/class/net/eth0/statistics/rx_packets');
    expect(await modalText(page)).toMatch(/statistics\/rx_packets\s*\n\s*\d+/);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'cat /sys/class/net/eth0/ifindex');
    expect(await modalText(page)).toMatch(/eth0\/ifindex\s*\n\s*2\b/);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'ls /sys/class/net/eth0/statistics/ | wc -l');
    expect(await modalText(page)).toMatch(/wc -l\s*\n\s*24\b/);

    await closeTerminal(page);
  });
});

import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
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

test.describe('dd occupe une place que les autres vues comptent', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('huit mebioctets ecrits, huit mebioctets vus', async ({ page }) => {
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'dd if=/dev/zero of=/tmp/gros bs=1M count=8');
    const sortie = await modalText(page);
    expect(sortie).toContain('8+0 records in');
    expect(sortie).toContain('8388608 bytes (8.4 MB, 8.0 MiB) copied');

    await typeCmd(page, 'clear');
    await typeCmd(page, 'ls -l /tmp/gros');
    expect(await modalText(page)).toContain('8388608');

    await typeCmd(page, 'clear');
    await typeCmd(page, 'du -sh /tmp/gros');
    expect(await modalText(page)).toMatch(/8\.0M\s+\/tmp\/gros/);

    await closeTerminal(page);
  });

  test('/proc/swaps et swapon -s disent la meme chose', async ({ page }) => {
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'cat /proc/swaps');
    expect(await modalText(page)).toContain('/swapfile');

    await typeCmd(page, 'clear');
    await typeCmd(page, 'swapon -s');
    expect(await modalText(page)).toContain('/swapfile');

    await closeTerminal(page);
  });
});

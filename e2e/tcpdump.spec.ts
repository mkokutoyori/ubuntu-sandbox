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
async function injectPacket(page: Page, id: string): Promise<void> {
  await page.evaluate((devId) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
    const dev = store.getState().deviceInstances.get(devId) as { executor: { captureLog: { capture(p: object): void } } };
    dev.executor.captureLog.capture({ at: new Date(), srcIp: '10.0.0.1', srcPort: 4444, dstIp: '10.0.0.2', dstPort: 80, flags: 'S', seq: 0, ack: 0, length: 0 });
  }, id);
}

test.beforeEach(async ({ page }) => { await page.goto('/'); await waitForStore(page); });

test('tcpdump streams a live captured packet and prints the summary on -c', async ({ page }) => {
  const id = await addDevice(page, 'linux-pc');
  await openTerminal(page, id);
  await typeCmd(page, 'tcpdump -c 1');
  expect(await modalText(page)).toContain('listening on eth0');
  await injectPacket(page, id);
  await page.waitForTimeout(400);
  const text = await modalText(page);
  expect(text).toContain('10.0.0.1.4444 > 10.0.0.2.80');
  expect(text).toContain('1 packet captured');
});

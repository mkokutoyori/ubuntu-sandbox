import { test, expect, type Page } from '@playwright/test';
import { fortiConsoleLogin } from './fortiConsole';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function poserFortiGate(page: Page): Promise<string> {
  return page.evaluate(() => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const created = store.getState().addDevice('firewall-fortinet', 320, 240);
    const device = store.getState().deviceInstances.get(created.id) as Record<string, unknown>;
    (device.powerOn as (() => void) | undefined)?.call(device);
    return created.id;
  });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]')
    .waitFor({ state: 'visible', timeout: 10_000 });
  await fortiConsoleLogin(page);
  await page.waitForTimeout(1500);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(200);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 10_000): Promise<void> {
  await expect.poll(
    async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

test.describe('FortiGate — piste d audit et seuils du tampon', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('une modification faite dans l onglet est journalisee `ui=jsconsole`',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      for (const ligne of [
        'config firewall address', 'edit "DEPUIS-ONGLET"',
        'set subnet 10.1.0.0 255.255.0.0', 'next', 'end',
      ]) await typeCmd(page, ligne);

      await typeCmd(page, 'execute log filter category event');
      await typeCmd(page, 'execute log display');
      await waitForText(page, 'jsconsole');

      expect(await modalText(page)).toContain('firewall.address');
    });

  test('les trois seuils du tampon portent leurs defauts reels',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      await typeCmd(page, 'show full-configuration log memory global-setting');
      await waitForText(page, 'set full-first-warning-threshold 75');

      const vue = await modalText(page);
      expect(vue).toContain('set full-second-warning-threshold 90');
      expect(vue).toContain('set full-final-warning-threshold 95');
    });
});

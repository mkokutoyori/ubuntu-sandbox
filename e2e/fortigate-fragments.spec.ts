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

function tail(vue: string, ancre: string): string {
  return vue.slice(vue.lastIndexOf(ancre));
}

test.describe('FortiGate — le recollage des fragments dans un vrai terminal', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('`diagnose snmp ip frags` rend les compteurs de la MIB IP',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      await typeCmd(page, 'diagnose snmp ip frags');
      await waitForText(page, 'ReasmTimeout');

      const rendu = tail(await modalText(page), 'ReasmTimeout');
      expect(rendu).toContain('ReasmReqds');
      expect(rendu).toContain('ReasmOKs');
      expect(rendu).toContain('ReasmFails');
    });

  test('`set ip-fragment-mem-thresholds` porte son defaut reel et se regle',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      await typeCmd(page, 'show full-configuration system settings');
      await waitForText(page, 'set ip-fragment-mem-thresholds 32');

      for (const ligne of [
        'config system settings', 'set ip-fragment-mem-thresholds 256', 'end',
      ]) await typeCmd(page, ligne);
      await typeCmd(page, 'show system settings');
      await waitForText(page, 'set ip-fragment-mem-thresholds 256');
    });

  test('une valeur hors bornes est refusee', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config system settings');
    await typeCmd(page, 'set ip-fragment-mem-thresholds 4096');
    await waitForText(page, 'value parse error');

    expect(await modalText(page)).toContain('ip-fragment-mem-thresholds');
  });
});

import { test, expect, type Page } from '@playwright/test';
import { fortiConsoleLogin } from './fortiConsole';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function poserGrappe(page: Page): Promise<string> {
  return page.evaluate(() => {
    type Device = Record<string, unknown>;
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Device>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const a = store.getState().addDevice('firewall-fortinet', 260, 200);
    const b = store.getState().addDevice('firewall-fortinet', 520, 200);
    const devA = store.getState().deviceInstances.get(a.id) as Device;
    const devB = store.getState().deviceInstances.get(b.id) as Device;
    for (const device of [devA, devB]) {
      (device.powerOn as (() => void) | undefined)?.call(device);
    }
    return JSON.stringify([a.id, b.id]);
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

test.describe('FortiGate — la voie de commande de grappe dans un vrai terminal', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('un index inconnu est refuse, et hors grappe la commande aussi',
    async ({ page }) => {
      const [id] = JSON.parse(await poserGrappe(page)) as string[];
      await openTerminal(page, id);

      await typeCmd(page, 'execute ha manage 1 admin');
      await waitForText(page, 'not part of a cluster');

      for (const ligne of [
        'config system ha',
        'set group-name "cluster-paris"',
        'set group-id 10',
        'set mode a-p',
        'set password "SecretHA"',
        'set hbdev "port7" 50',
        'end',
      ]) await typeCmd(page, ligne);

      await typeCmd(page, 'execute ha manage 9 admin');
      await waitForText(page, 'no cluster member');
    });

  test('sans reponse de la grappe, `synchronize start` le dit',
    async ({ page }) => {
      const [id] = JSON.parse(await poserGrappe(page)) as string[];
      await openTerminal(page, id);

      for (const ligne of [
        'config system ha',
        'set group-name "cluster-paris"',
        'set group-id 10',
        'set mode a-p',
        'set password "SecretHA"',
        'set hbdev "port7" 50',
        'end',
      ]) await typeCmd(page, ligne);

      await typeCmd(page, 'execute ha synchronize start');
      await waitForText(page, 'no response from the cluster');
    });
});

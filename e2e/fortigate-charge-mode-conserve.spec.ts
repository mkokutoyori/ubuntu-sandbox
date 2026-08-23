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
  await page.waitForTimeout(250);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 10_000): Promise<void> {
  await expect.poll(
    async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

test.describe('FortiGate — la charge dans un vrai terminal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('`get system performance status` rend une mesure, pas une constante',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      await typeCmd(page, 'get system performance status');
      await waitForText(page, 'CPU states:');

      const vue = await modalText(page);
      expect(vue).toMatch(/Memory: \d+k total/);

      const utilisee = /(\d+)k used/.exec(vue);
      expect(utilisee).not.toBeNull();
      expect(Number(utilisee?.[1] ?? '0')).toBeGreaterThan(0);

      expect(vue).toContain('Average session setup rate:');
      expect(vue).not.toContain('Current sessions:');
    });

  test('`diagnose hardware sysinfo conserve` rend les seuils REGLES',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      await typeCmd(page, 'config system global');
      await typeCmd(page, 'set memory-use-threshold-red 85');
      await typeCmd(page, 'set memory-use-threshold-green 80');
      await typeCmd(page, 'end');

      await typeCmd(page, 'diagnose hardware sysinfo conserve');
      await waitForText(page, 'memory conserve mode:');

      const vue = await modalText(page);
      expect(vue).toMatch(/threshold red:\s+\d+ MB\s+85% of total RAM/);
      expect(vue).toMatch(/threshold green:\s+\d+ MB\s+80% of total RAM/);
    });

  test('sur-dimensionner le tampon de journaux ALLUME le mode conserve',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      await typeCmd(page, 'diagnose hardware sysinfo conserve');
      await waitForText(page, 'memory conserve mode:');
      expect(await modalText(page)).toMatch(/memory conserve mode:\s+off/);

      await typeCmd(page, 'config log memory global-setting');
      await typeCmd(page, 'set max-size 1800000000');
      await typeCmd(page, 'end');
      await typeCmd(page, 'diagnose hardware sysinfo conserve');

      await expect.poll(async () =>
        /memory conserve mode:\s+on/.test(await modalText(page)),
      { timeout: 10_000 }).toBe(true);
    });

  test('`diagnose sys top` rend une part memoire par processus',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      await typeCmd(page, 'diagnose sys top');
      await waitForText(page, 'Run Time:');

      const vue = await modalText(page);
      expect(vue).toContain('newcli');
      expect(vue).toMatch(/newcli\s+\d+\s+\w+\s+\d+\.\d\s+\d+\.\d/);
      expect(vue).not.toMatch(/newcli\s+\d+\s+\w+\s+0\.0\s+0\.0\s*$/m);
    });

  test('un seuil hors bornes est refuse et la configuration ne le garde pas',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      await typeCmd(page, 'config system global');
      await typeCmd(page, 'set memory-use-threshold-red 5');
      await waitForText(page, 'expected <70-97>');
      await typeCmd(page, 'end');
      await typeCmd(page, 'show system global');
      await waitForText(page, 'show system global');

      const vue = await modalText(page);
      const rendu = vue.slice(vue.lastIndexOf('show system global'));
      expect(rendu).toContain('config system global');
      expect(rendu).not.toContain('memory-use-threshold-red');
    });
});

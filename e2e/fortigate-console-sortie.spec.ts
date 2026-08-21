import { test, expect, type Page } from '@playwright/test';
import { fortiConsoleLogin, FORTI_LAB_PASSWORD } from './fortiConsole';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await fortiConsoleLogin(page);
  await page.waitForTimeout(1500);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(300);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 15_000): Promise<void> {
  await expect.poll(async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
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

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — la console se quitte et se regle', () => {
  test('`exit` rend l`invite de connexion, et on rentre a nouveau', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'exit');
    await waitForText(page, 'login:');

    const passwordField = page.locator('[data-testid="terminal-modal"] input[type="password"]');
    await typeCmd(page, 'admin');
    await passwordField.last().fill(FORTI_LAB_PASSWORD);
    await passwordField.last().press('Enter');
    await page.waitForTimeout(500);

    await typeCmd(page, 'get system status');
    await waitForText(page, 'Version: FortiGate-VM64');
  });

  test('`execute reboot` demande confirmation et `n` annule', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'execute reboot');
    await waitForText(page, 'This operation will reboot the system !');
    await waitForText(page, 'Do you want to continue? (y/n)');

    await typeCmd(page, 'n');
    await typeCmd(page, 'get system status');
    await waitForText(page, 'Version: FortiGate-VM64');
  });

  test('`set output standard` supprime le `--More--`', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config system console', 'set output standard', 'end']) {
      await typeCmd(page, c);
    }
    await typeCmd(page, 'get system interface');

    const vu = await modalText(page);
    expect(vu).not.toContain('--More--');
  });
});

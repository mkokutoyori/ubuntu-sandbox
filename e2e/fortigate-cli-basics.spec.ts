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
  await page.waitForTimeout(1200);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const box = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await box.focus();
  await box.fill(command);
  await box.press('Enter');
  await page.waitForTimeout(250);
}

async function waitForText(page: Page, needle: string, timeout = 12_000): Promise<void> {
  await expect.poll(
    async () => (await page.locator('[data-testid="terminal-modal"]').innerText())
      .includes(needle), { timeout }).toBe(true);
}

test.describe('FortiGate — ce que la page « CLI basics » decrit', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('`set hostname $SerialNum` pose le numero de serie', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'get system status | grep Serial-Number');
    await waitForText(page, 'Serial-Number: FGVMEV');

    for (const ligne of [
      'config system global', 'set hostname $SerialNum', 'end',
      'get system status | grep Hostname',
    ]) await typeCmd(page, ligne);

    await waitForText(page, 'Hostname: FGVMEV');
  });

  test('une ligne terminee par `\\` continue sur la suivante', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const ligne of [
      'config system \\', 'interface', 'edit "port1"',
      'set allowaccess ping \\', 'https ssh', 'next', 'end',
      'show system interface | grep allowaccess',
    ]) await typeCmd(page, ligne);

    await waitForText(page, 'set allowaccess ping https ssh');
  });

  test('une valeur entre guillemets peut contenir un espace', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const ligne of [
      'config firewall address', 'edit "serveur web"',
      'set subnet 10.0.0.1 255.255.255.255', 'next', 'end',
      'show firewall address',
    ]) await typeCmd(page, ligne);

    await waitForText(page, 'edit "serveur web"');
  });
});

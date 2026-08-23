import { test, expect, type Page } from '@playwright/test';
import { fortiConsoleLogin } from './fortiConsole';

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
  await page.waitForTimeout(200);
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

const GRAPPE = [
  'config system ha',
  'set group-name "cluster-paris"',
  'set group-id 10',
  'set mode a-p',
  'set password "SecretHA"',
  'set hbdev "port7" 50',
  'set priority 200',
  'end',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — HA dans le terminal', () => {
  test('la grappe se declare et `show` la reproduit sans le mot de passe', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...GRAPPE, 'show system ha']) await typeCmd(page, c);

    await waitForText(page, 'set group-name "cluster-paris"');
    await waitForText(page, 'set mode a-p');

    const rendu = (await modalText(page)).split('# show system ha').pop() ?? '';
    expect(rendu).toContain('set password ENC');
    expect(rendu).not.toContain('SecretHA');
  });

  test('`get system ha status` rend le format de FortiOS', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...GRAPPE, 'get system ha status']) await typeCmd(page, c);

    await waitForText(page, 'HA Health Status: OK');
    await waitForText(page, 'Mode: HA A-P');
  });

  test('`set mode ?` annonce les trois modes', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config system ha', 'set mode ?']) await typeCmd(page, c);

    await waitForText(page, 'standalone');
    await waitForText(page, 'a-p');
  });

  test('`execute ha failover set` est refuse hors grappe', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'execute ha failover set');

    await waitForText(page, 'Command fail');
  });
});

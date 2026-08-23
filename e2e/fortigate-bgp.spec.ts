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

const INTERFACES = [
  'config system interface',
  'edit "port1"', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
  'edit "port2"', 'set mode static', 'set ip 10.0.0.1 255.255.255.0', 'next', 'end',
];

const BGP = [
  'config router bgp',
  'set as 65001',
  'set router-id 1.1.1.1',
  'config neighbor', 'edit "10.0.0.2"', 'set remote-as 65002', 'next', 'end',
  'config network', 'edit 1', 'set prefix 192.168.1.0 255.255.255.0', 'next', 'end',
  'end',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — BGP dans le terminal', () => {
  test('`config router bgp` est accepte et `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACES, ...BGP, 'show router bgp']) await typeCmd(page, c);

    await waitForText(page, 'set as 65001');
    await waitForText(page, 'edit "10.0.0.2"');
    await waitForText(page, 'set remote-as 65002');
  });

  test('un numero de systeme autonome hors bornes est refuse', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config router bgp', 'set as 4294967296']) await typeCmd(page, c);

    await waitForText(page, 'Command fail. Return code -61');
    await typeCmd(page, 'abort');
  });

  test('un voisin sans `remote-as` est refuse au commit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config router bgp', 'set as 65001', 'config neighbor',
      'edit "10.0.0.2"', 'next', 'end', 'end']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'remote-as');
    await typeCmd(page, 'abort');
  });

  test('`get router info bgp summary` rend l`en-tete du vrai FortiGate', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACES, ...BGP, 'get router info bgp summary']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'BGP router identifier 1.1.1.1, local AS number 65001');
    await waitForText(page, 'State/PfxRcd');
    await waitForText(page, 'Total number of neighbors 1');
  });

  test('`get router info bgp neighbors` decrit le voisin', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACES, ...BGP, 'get router info bgp neighbors']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'BGP neighbor is 10.0.0.2, remote AS 65002, local AS 65001');
  });
});

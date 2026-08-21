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

const OSPF = [
  'config router ospf',
  'set router-id 1.1.1.1',
  'config area', 'edit 0.0.0.0', 'next', 'end',
  'config network',
  'edit 1', 'set prefix 10.0.0.0 255.255.255.0', 'set area 0.0.0.0', 'next',
  'edit 2', 'set prefix 192.168.1.0 255.255.255.0', 'set area 0.0.0.0', 'next', 'end',
  'end',
];

const RIP = [
  'config router rip',
  'set version 2',
  'config network', 'edit 1', 'set prefix 10.0.0.0 255.255.255.0', 'next', 'end',
  'end',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — routage dynamique dans le terminal', () => {
  test('`config router ospf` est accepte et `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACES, ...OSPF, 'show router ospf']) await typeCmd(page, c);

    await waitForText(page, 'set router-id 1.1.1.1');
    await waitForText(page, 'edit 0.0.0.0');
    await waitForText(page, 'set prefix 10.0.0.0 255.255.255.0');
  });

  test('un identifiant de routeur nul est refuse', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config router ospf', 'set router-id 0.0.0.0', 'end']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'Command fail');
    await typeCmd(page, 'abort');
  });

  test('`config router rip` est accepte et `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACES, ...RIP, 'show router rip']) await typeCmd(page, c);

    await waitForText(page, 'set version 2');
    await waitForText(page, 'set prefix 10.0.0.0 255.255.255.0');
  });

  test('la table de routage nomme ses codes de protocole', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACES, 'get router info routing-table all']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'R - RIP');
    await waitForText(page, 'O - OSPF');
    await waitForText(page, '192.168.1.0/24 is directly connected, port1');
  });

  test('`config router bgp` est accepte et l`invite descend', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config router bgp');
    await waitForText(page, '(bgp) #');

    const vu = await modalText(page);
    expect(vu).not.toContain('Command fail');
  });
});

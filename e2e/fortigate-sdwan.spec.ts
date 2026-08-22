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

const MEMBRES = [
  'config system interface',
  'edit "port2"', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next',
  'edit "port3"', 'set mode static', 'set ip 198.51.100.1 255.255.255.0', 'next', 'end',
  'config system sdwan',
  'set status enable',
  'config members',
  'edit 1', 'set interface "port2"', 'set gateway 203.0.113.254', 'next',
  'edit 2', 'set interface "port3"', 'set gateway 198.51.100.254', 'next', 'end',
  'end',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — SD-WAN dans le terminal', () => {
  test('les membres se declarent et `show` les reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...MEMBRES, 'show system sdwan']) await typeCmd(page, c);

    await waitForText(page, 'set interface "port2"');
    await waitForText(page, 'set gateway 198.51.100.254');
  });

  test('`diagnose sys sdwan member` rend la liste', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...MEMBRES, 'diagnose sys sdwan member']) await typeCmd(page, c);

    await waitForText(page, 'Member(1): interface: port2');
  });

  test('l`aide de `latency-threshold` nomme la limite du simulateur', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config system sdwan', 'config health-check', 'edit "x"',
      'config sla', 'edit 1', 'set latency-threshold ?',
    ]) await typeCmd(page, c);

    await waitForText(page, 'synchronously');
  });
});

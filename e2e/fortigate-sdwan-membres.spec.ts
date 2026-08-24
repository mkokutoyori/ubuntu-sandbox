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

const ADRESSES = [
  'config system interface',
  'edit "port1"', 'set mode static', 'set ip 10.0.1.1 255.255.255.0', 'next',
  'edit "port2"', 'set mode static', 'set ip 10.0.2.1 255.255.255.0', 'next',
  'end',
];

test.describe('FortiGate — membres SD-WAN et references', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('une interface nommee par une politique est refusee comme membre',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      for (const ligne of [
        ...ADRESSES,
        'config firewall policy', 'edit 1',
        'set srcintf "port2"', 'set dstintf "port1"',
        'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
        'set action accept', 'set schedule "always"', 'next', 'end',
        'config system sdwan', 'set status enable', 'config members',
        'edit 1', 'set interface "port1"', 'set gateway 10.0.1.254', 'next',
        'end', 'end',
      ]) await typeCmd(page, ligne);

      await waitForText(page, 'entry not found in datasource');
    });

  test('`diagnose sys cmdb refcnt show` nomme ce qui reference l interface',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      for (const ligne of [
        ...ADRESSES,
        'config firewall policy', 'edit 1',
        'set srcintf "port2"', 'set dstintf "port1"',
        'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
        'set action accept', 'set schedule "always"', 'next', 'end',
        'diagnose sys cmdb refcnt show system.interface.name port1',
      ]) await typeCmd(page, ligne);

      await waitForText(page, 'of table firewall.policy:policyid');
    });

  test('un membre ajoute apres la route de zone developpe sa route',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      for (const ligne of [
        ...ADRESSES,
        'config system sdwan', 'set status enable',
        'config zone', 'edit "virtual-wan-link"', 'next', 'end',
        'config members', 'edit 1', 'set interface "port1"',
        'set gateway 10.0.1.254', 'set zone "virtual-wan-link"', 'next',
        'end', 'end',
        'config router static', 'edit 1', 'set dst 0.0.0.0 0.0.0.0',
        'set device "virtual-wan-link"', 'next', 'end',
        'config system sdwan', 'config members', 'edit 2',
        'set interface "port2"', 'set gateway 10.0.2.254',
        'set zone "virtual-wan-link"', 'next', 'end', 'end',
        'get router info routing-table all',
      ]) await typeCmd(page, ligne);

      await waitForText(page, '10.0.2.254');
    });
});

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

test.describe('FortiGate — politique IPv6', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('un objet adresse IPv6 se pose et se relit', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const ligne of [
      'config firewall address6', 'edit "reseau-b"',
      'set type ipprefix', 'set ip6 2001:db8:2::/64', 'next', 'end',
      'show firewall address6',
    ]) await typeCmd(page, ligne);

    await waitForText(page, 'set ip6 2001:db8:2::/64');
  });

  test('`srcaddr6` et `dstaddr6` se posent sur la politique unifiee',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      for (const ligne of [
        'config firewall policy', 'edit 1',
        'set srcintf "port1"', 'set dstintf "port2"',
        'set srcaddr6 "all6"', 'set dstaddr6 "all6"',
        'set service "ALL"', 'set action accept', 'set schedule "always"',
        'next', 'end',
        'show firewall policy',
      ]) await typeCmd(page, ligne);

      await waitForText(page, 'set srcaddr6 "all6"');
    });

  test('`config firewall policy6` est refusee sur une 7.6', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config firewall policy6');

    await waitForText(page, 'unknown configuration path');
  });

  test('un prefixe v6 mal ecrit est refuse', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const ligne of [
      'config firewall address6', 'edit "faux"',
      'set type ipprefix', 'set ip6 192.168.1.0/24',
    ]) await typeCmd(page, ligne);

    await waitForText(page, 'value parse error');
  });
});

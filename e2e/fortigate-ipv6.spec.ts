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

const ADRESSE_V6 = [
  'config system interface',
  'edit "port1"',
  'config ipv6',
  'set ip6-address 2001:db8::1/64',
  'set ip6-allowaccess ping',
  'end',
  'next',
  'end',
];

test.describe('FortiGate — IPv6', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('une adresse IPv6 posee se relit dans la configuration', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const ligne of [...ADRESSE_V6, 'show system interface port1']) {
      await typeCmd(page, ligne);
    }

    await waitForText(page, 'set ip6-address 2001:db8::1/64');
  });

  test('`diagnose ipv6 address list` nomme l adresse', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const ligne of [...ADRESSE_V6, 'diagnose ipv6 address list']) {
      await typeCmd(page, ligne);
    }

    await waitForText(page, '2001:db8::1/64');
  });

  test('`execute ping6` sans route rend le refus de FortiOS', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const ligne of [...ADRESSE_V6, 'execute ping6 2001:db9::99']) {
      await typeCmd(page, ligne);
    }

    await waitForText(page, 'Unable to send the ICMP packet');
  });

  test('`config router static6` pose une route lue par `get router info6`',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      for (const ligne of [
        ...ADRESSE_V6,
        'config router static6', 'edit 1', 'set dst ::/0',
        'set gateway 2001:db8::254', 'set device "port1"', 'next', 'end',
        'get router info6 routing-table',
      ]) await typeCmd(page, ligne);

      await waitForText(page, '2001:db8::254');
    });
});

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
  await page.waitForTimeout(250);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 10_000): Promise<void> {
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

const TUNNEL = [
  'config vpn ipsec phase1-interface', 'edit "vers_site_b"',
  'set interface "port2"', 'set ike-version 2',
  'set remote-gw 198.51.100.1', 'set psksecret "SecretPartage2026"',
  'set proposal aes256-sha256', 'set dhgrp 14',
  'next', 'end',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — IPsec dans le terminal', () => {
  test('un tunnel se declare et le `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...TUNNEL, 'show vpn ipsec phase1-interface']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'edit "vers_site_b"');
    await waitForText(page, 'set remote-gw 198.51.100.1');
  });

  test('le tunnel devient une interface qu`une route peut designer', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      ...TUNNEL,
      'config router static', 'edit 3',
      'set dst 192.168.2.0 255.255.255.0',
      'set device "vers_site_b"', 'next', 'end',
      'show router static',
    ]) await typeCmd(page, c);

    await waitForText(page, 'set device "vers_site_b"');
  });

  test('`diagnose vpn tunnel list` rend le format de FortiOS', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      ...TUNNEL,
      'config vpn ipsec phase2-interface', 'edit "p2"',
      'set phase1name "vers_site_b"',
      'set src-subnet 192.168.1.0 255.255.255.0',
      'set dst-subnet 192.168.2.0 255.255.255.0',
      'next', 'end',
      'diagnose vpn tunnel list',
    ]) await typeCmd(page, c);

    await waitForText(page, 'name=vers_site_b ver=2');
    await waitForText(page, 'proxyid_num=1');
  });

  test('un groupe Diffie-Hellman non calculable est refuse', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config vpn ipsec phase1-interface', 'edit "T"', 'set dhgrp 18',
    ]) await typeCmd(page, c);

    await waitForText(page, 'Command fail');
  });

  test('`set dhgrp ?` annonce le groupe 14', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config vpn ipsec phase1-interface', 'edit "T"', 'set dhgrp ?']) {
      await typeCmd(page, c);
    }

    await waitForText(page, '14');
  });

  test('le mode policy-based est propose et dit herite', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config vpn ipsec ?');

    await waitForText(page, 'phase1-interface');
    await waitForText(page, 'legacy');
  });
});

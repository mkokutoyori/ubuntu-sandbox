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
  'edit "port2"', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end',
];

const UTILISATEURS = [
  'config user local', 'edit "alice"',
  'set type password', 'set passwd "Secret123"', 'next', 'end',
  'config user group', 'edit "employes"', 'set member "alice"', 'next', 'end',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — portail captif dans le terminal', () => {
  test('`set security-mode captive-portal` est accepte et `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACES, 'config system interface', 'edit "port1"',
      'set security-mode captive-portal', 'next', 'end', 'show system interface']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'set security-mode captive-portal');
  });

  test('`auth-http-port` est accepte et `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config system global', 'set auth-http-port 8010', 'end',
      'show system global']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'set auth-http-port 8010');
  });

  test('une politique avec `set groups` est acceptee', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACES, ...UTILISATEURS,
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set groups "employes"', 'next', 'end', 'show firewall policy']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'set groups "employes"');
  });

  test('le portail ecoute une fois l`authentification exigee', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACES, ...UTILISATEURS,
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set groups "employes"', 'next', 'end',
      'diagnose sys session list']) {
      await typeCmd(page, c);
    }

    const texte = await modalText(page);
    expect(texte).not.toContain('Command fail');
  });

  test('`set security-mode none` est accepte et `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACES, 'config system interface', 'edit "port1"',
      'set security-mode captive-portal', 'next', 'end',
      'config system interface', 'edit "port1"',
      'set security-mode none', 'next', 'end', 'show system interface']) {
      await typeCmd(page, c);
    }

    const texte = await modalText(page);
    expect(texte).not.toContain('Command fail');
  });
});

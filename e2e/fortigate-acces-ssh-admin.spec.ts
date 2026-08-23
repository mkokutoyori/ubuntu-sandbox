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

const INTERFACE = [
  'config system interface',
  'edit "port1"',
  'set mode static',
  'set ip 192.168.1.1 255.255.255.0',
  'set allowaccess ping ssh',
  'next',
  'end',
];

const COMPTE = [
  'config system admin',
  'edit "admin"',
  'set password "Secret123"',
  'set accprofile "super_admin"',
  'next',
  'end',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — acces de gestion dans le terminal', () => {
  test('`set allowaccess ping ssh` est accepte et `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACE, 'show system interface']) await typeCmd(page, c);

    await waitForText(page, 'set allowaccess ping ssh');
  });

  test('`admin-ssh-port` est accepte et rendu', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config system global', 'set admin-ssh-port 2222', 'end',
      'show system global']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'set admin-ssh-port 2222');
  });

  test('l`invite de configuration nomme le DERNIER mot du chemin', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config system global');

    await waitForText(page, '(global) #');
    expect(await modalText(page)).not.toContain('(system global) #');
    await typeCmd(page, 'end');
  });

  test('`set trusthost1` est accepte et rendu sur le compte', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...COMPTE, 'config system admin', 'edit "admin"',
      'set trusthost1 192.168.1.0 255.255.255.0', 'next', 'end',
      'show system admin']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'set trusthost1 192.168.1.0 255.255.255.0');
  });

  test('un service de gestion inconnu est refuse', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config system interface', 'edit "port1"',
      'set allowaccess pas-un-service']) {
      await typeCmd(page, c);
    }

    const texte = await modalText(page);
    expect(texte).toMatch(/Command fail|value parse error|Invalid/i);
    await typeCmd(page, 'abort');
  });
});

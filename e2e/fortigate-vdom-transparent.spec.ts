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

const MULTI_VDOM = [
  'config system global',
  'set vdom-mode multi-vdom',
  'end',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — VDOM et mode transparent dans le terminal', () => {
  test('`config vdom` cree un domaine et le `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    for (const c of MULTI_VDOM) await typeCmd(page, c);

    for (const c of ['config vdom', 'edit VENTES', 'next', 'end']) await typeCmd(page, c);
    await typeCmd(page, 'show vdom');
    await waitForText(page, 'edit "VENTES"');
  });

  test('l\'invite indique le VDOM courant', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    for (const c of MULTI_VDOM) await typeCmd(page, c);

    await typeCmd(page, 'config vdom');
    await typeCmd(page, 'edit VENTES');
    await typeCmd(page, 'get system status');

    await waitForText(page, '(VENTES) #');
  });

  test('`config global` n\'existe qu\'en multi-VDOM', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config global');
    await waitForText(page, 'multi-vdom');
  });

  test('un VDOM porte sa propre politique, sur le meme identifiant', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    for (const c of MULTI_VDOM) await typeCmd(page, c);

    for (const c of [
      'config vdom', 'edit VENTES',
      'config firewall policy', 'edit 1', 'set name VENTE-SORTIE',
      'set action accept', 'next', 'end',
      'show firewall policy',
    ]) await typeCmd(page, c);

    await waitForText(page, 'set name "VENTE-SORTIE"');
  });

  test('`set opmode transparent` ouvre `manageip` et ferme l\'adressage', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config system settings', 'set opmode transparent',
      'set manageip 192.168.1.99 255.255.255.0', 'end',
    ]) await typeCmd(page, c);

    await typeCmd(page, 'show system settings');
    await waitForText(page, 'set manageip 192.168.1.99 255.255.255.0');

    await typeCmd(page, 'config system interface');
    await typeCmd(page, 'edit port1');
    await typeCmd(page, 'set ip 192.168.1.1 255.255.255.0');
    await waitForText(page, 'does not apply');
  });

  test('`config system switch-interface` regroupe des ports', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config system switch-interface', 'edit lan',
      'set member port3 port4 port5', 'next', 'end',
      'show system switch-interface',
    ]) await typeCmd(page, c);

    await waitForText(page, 'edit "lan"');
    const vu = await modalText(page);
    expect(vu).toContain('set member "port3" "port4" "port5"');
  });
});

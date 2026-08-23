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
  await page.waitForTimeout(250);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 10_000): Promise<void> {
  await expect.poll(
    async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

function tail(vue: string, ancre: string): string {
  return vue.slice(vue.lastIndexOf(ancre));
}

async function passerEnTransparent(page: Page): Promise<void> {
  await typeCmd(page, 'config system settings');
  await typeCmd(page, 'set opmode transparent');
  await typeCmd(page, 'set manageip 192.168.1.99 255.255.255.0');
  await typeCmd(page, 'end');
}

test.describe('FortiGate — le pont du mode transparent dans un vrai terminal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('`diagnose netlink brctl list` nomme le pont du VDOM', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    await passerEnTransparent(page);

    await typeCmd(page, 'diagnose netlink brctl list');
    await waitForText(page, 'list bridge information');

    expect(await modalText(page)).toContain('root.b');
  });

  test('`name host root.b` rend le tableau avec ses colonnes reelles',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);
      await passerEnTransparent(page);

      await typeCmd(page, 'diagnose netlink brctl name host root.b');
      await waitForText(page, 'show bridge control interface');

      const rendu = tail(await modalText(page), 'show bridge control interface');
      expect(rendu).toContain('port no');
      expect(rendu).toContain('devname');
      expect(rendu).toContain('mac addr');
      expect(rendu).toContain('ttl');
    });

  test('un pont qui n existe pas est nomme comme tel', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    await passerEnTransparent(page);

    await typeCmd(page, 'diagnose netlink brctl name host absent.b');
    await waitForText(page, 'does not exist');

    const rendu = tail(await modalText(page), 'brctl name host absent.b');
    expect(rendu).not.toContain('port no');
  });

  test('la commande est proposee par la completion', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'diagnose netlink ?');
    await waitForText(page, 'brctl');

    expect(await modalText(page)).toContain('brctl');
  });
});

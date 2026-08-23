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

test.describe('FortiGate — l historique de configuration dans un vrai terminal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('`execute revision list config` rend les colonnes du vrai outil',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      await typeCmd(page, 'execute revision list config');
      await waitForText(page, 'FIRMWARE VERSION');

      const rendu = tail(await modalText(page), 'execute revision list config');
      expect(rendu).toContain('ID');
      expect(rendu).toContain('TIME');
      expect(rendu).toContain('ADMIN');
      expect(rendu).toContain('COMMENT');
    });

  test('`revision-backup-on-logout` se regle et se relit', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config system global');
    await typeCmd(page, 'set revision-backup-on-logout enable');
    await typeCmd(page, 'end');
    await typeCmd(page, 'show system global');
    await waitForText(page, 'config system global');

    const rendu = tail(await modalText(page), 'show system global');
    expect(rendu).toContain('set revision-backup-on-logout enable');
  });

  test('`vdom-mode` est CACHEE de la configuration rendue', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config system global');
    await typeCmd(page, 'set vdom-mode multi-vdom');
    await typeCmd(page, 'end');
    await typeCmd(page, 'show system global');
    await waitForText(page, 'config system global');

    const rendu = tail(await modalText(page), 'show system global');
    expect(rendu).not.toContain('vdom-mode');
  });

  test('une revision inconnue est refusee', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'execute restore config flash 42');
    await waitForText(page, 'does not exist');

    expect(await modalText(page)).toContain('revision 42 does not exist');
  });
});

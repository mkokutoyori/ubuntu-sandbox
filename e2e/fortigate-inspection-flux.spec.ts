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

test.describe('FortiGate — les bornes de mise en tampon dans un vrai terminal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('`oversize-limit` se regle et se relit dans la configuration',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      await typeCmd(page, 'config firewall profile-protocol-options');
      await typeCmd(page, 'edit "PPO"');
      await typeCmd(page, 'config http');
      await typeCmd(page, 'set oversize-limit 3');
      await typeCmd(page, 'end');
      await typeCmd(page, 'next');
      await typeCmd(page, 'end');
      await typeCmd(page, 'show firewall profile-protocol-options "PPO"');
      await waitForText(page, 'show firewall profile-protocol-options');

      const rendu = tail(await modalText(page), 'show firewall profile-protocol-options');
      expect(rendu).toContain('set oversize-limit 3');
    });

  test('un `oversize-limit` hors bornes est refuse', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config firewall profile-protocol-options');
    await typeCmd(page, 'edit "PPO"');
    await typeCmd(page, 'config http');
    await typeCmd(page, 'set oversize-limit 0');
    await waitForText(page, 'value parse error');

    await typeCmd(page, 'end');
    await typeCmd(page, 'next');
    await typeCmd(page, 'end');
    await typeCmd(page, 'show firewall profile-protocol-options "PPO"');
    await waitForText(page, 'show firewall profile-protocol-options');

    const rendu = tail(await modalText(page), 'show firewall profile-protocol-options');
    expect(rendu).not.toContain('set oversize-limit 0');
  });

  test('`set options oversize` se retrouve dans la configuration',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      await typeCmd(page, 'config firewall profile-protocol-options');
      await typeCmd(page, 'edit "PPO"');
      await typeCmd(page, 'config http');
      await typeCmd(page, 'set options oversize');
      await typeCmd(page, 'end');
      await typeCmd(page, 'next');
      await typeCmd(page, 'end');
      await typeCmd(page, 'show firewall profile-protocol-options "PPO"');
      await waitForText(page, 'show firewall profile-protocol-options');

      const rendu = tail(await modalText(page), 'show firewall profile-protocol-options');
      expect(rendu).toContain('set options oversize');
    });

  test('la valeur par defaut est 10 megaoctets', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config firewall profile-protocol-options');
    await typeCmd(page, 'edit "PPO"');
    await typeCmd(page, 'next');
    await typeCmd(page, 'end');
    await typeCmd(page,
      'show full-configuration firewall profile-protocol-options "PPO"');
    await waitForText(page, 'show full-configuration');

    const rendu = tail(await modalText(page), 'show full-configuration');
    expect(rendu).toContain('set oversize-limit 10');
  });
});

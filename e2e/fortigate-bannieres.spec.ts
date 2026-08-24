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

const BANNIERE = 'ACCES RESERVE AUX PERSONNES AUTORISEES';

test.describe('FortiGate — bannieres et historique des mots de passe', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('la banniere posee se relit dans la configuration', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const ligne of [
      `config system replacemsg admin "pre_admin-disclaimer-text"`,
      `set buffer "${BANNIERE}"`,
      'end',
      'config system global',
      'set pre-login-banner enable',
      'end',
      'show system global',
    ]) await typeCmd(page, ligne);

    await waitForText(page, 'set pre-login-banner enable');
  });

  test('un mot de passe deja employe est refuse', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const ligne of [
      'config system password-policy',
      'set status enable',
      'set apply-to admin-password',
      'set minimum-length 8',
      'set reuse-password disable',
      'end',
      'config system admin',
      'edit "admin"',
      'set password "SecretPremier1"',
      'next',
      'end',
      'config system admin',
      'edit "admin"',
      'set password "SecretSecond2"',
      'next',
      'end',
      'config system admin',
      'edit "admin"',
      'set password "SecretPremier1"',
      'next',
      'end',
    ]) await typeCmd(page, ligne);

    await waitForText(page, 'already been used');
  });
});

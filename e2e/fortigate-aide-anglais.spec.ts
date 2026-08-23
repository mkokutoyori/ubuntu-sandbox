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

const ACCENTS = /[àâçéèêëîïôùûü]/;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — `?` descend, et l\'interface parle anglais', () => {
  test('`config ?` annonce les branches et non la racine', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config ?');
    await waitForText(page, 'Configure firewall.');

    const vu = await modalText(page);
    expect(vu).toContain('Configure router.');
    expect(vu).toContain('Configure system settings.');
    expect(vu.split('config ?').pop() ?? '').not.toContain('Diagnose facility.');
  });

  test('`config firewall ?` annonce les tables du pare-feu', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config firewall ?');
    await waitForText(page, 'policy');

    const vu = await modalText(page);
    expect(vu).toContain('address');
    expect(vu).toContain('vip');
  });

  test('aucun refus n\'est redige en francais', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config');
    await waitForText(page, 'Command fail');
    await typeCmd(page, 'nimportequoi');
    await waitForText(page, 'Unknown action 0');
    await typeCmd(page, 'config nimportequoi');

    const vu = await modalText(page);
    expect(vu).toContain('unknown configuration path');
    expect(vu).not.toMatch(ACCENTS);
  });
});

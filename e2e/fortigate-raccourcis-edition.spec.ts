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
  await page.waitForTimeout(1200);
}

function box(page: Page) {
  return page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
}

async function caret(page: Page): Promise<number | null> {
  return box(page).evaluate((el) => (el as HTMLInputElement).selectionStart);
}

async function tape(page: Page, texte: string): Promise<void> {
  const input = box(page);
  await input.click();
  await input.fill(texte);
  await page.waitForTimeout(120);
}

async function touche(page: Page, key: string): Promise<void> {
  await box(page).press(key);
  await page.waitForTimeout(150);
}

async function poserRouteur(page: Page): Promise<string> {
  return page.evaluate(() => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const created = store.getState().addDevice('router-cisco', 320, 240);
    const device = store.getState().deviceInstances.get(created.id) as Record<string, unknown>;
    (device.powerOn as (() => void) | undefined)?.call(device);
    return created.id;
  });
}

test.describe('FortiGate — les raccourcis d\'edition de ligne', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('Ctrl+A va au debut, Ctrl+E a la fin', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    await tape(page, 'get system status');

    await touche(page, 'Control+a');
    expect(await caret(page)).toBe(0);

    await touche(page, 'Control+e');
    expect(await caret(page)).toBe('get system status'.length);
  });

  test('Ctrl+B recule, Ctrl+F avance', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    await tape(page, 'config');

    await touche(page, 'Control+b');
    expect(await caret(page)).toBe(5);
    await touche(page, 'Control+b');
    expect(await caret(page)).toBe(4);
    await touche(page, 'Control+f');
    expect(await caret(page)).toBe(5);
  });

  test('Ctrl+D efface le caractere sous le curseur', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    await tape(page, 'confXig');

    await touche(page, 'Control+a');
    for (let i = 0; i < 4; i++) await touche(page, 'Control+f');
    await touche(page, 'Control+d');

    expect(await box(page).inputValue()).toBe('config');
  });

  test('Ctrl+P et Ctrl+N parcourent l\'historique', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await tape(page, 'get system status');
    await touche(page, 'Enter');
    await tape(page, 'get system performance status');
    await touche(page, 'Enter');

    await touche(page, 'Control+p');
    expect(await box(page).inputValue()).toBe('get system performance status');
    await touche(page, 'Control+p');
    expect(await box(page).inputValue()).toBe('get system status');
    await touche(page, 'Control+n');
    expect(await box(page).inputValue()).toBe('get system performance status');
  });

  test('le routeur Cisco les porte aussi — un seul mecanisme', async ({ page }) => {
    const id = await poserRouteur(page);
    await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
    await page.locator('[data-testid="terminal-modal"]')
      .waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(1500);
    await tape(page, 'show verXsion');

    await touche(page, 'Control+a');
    expect(await caret(page)).toBe(0);
    for (let i = 0; i < 8; i++) await touche(page, 'Control+f');
    await touche(page, 'Control+d');

    expect(await box(page).inputValue()).toBe('show version');
  });

  test('un caractere tape au curseur s\'insere a sa place', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    await tape(page, 'confg');

    await touche(page, 'Control+a');
    for (let i = 0; i < 4; i++) await touche(page, 'Control+f');
    await box(page).press('i');
    await page.waitForTimeout(150);

    expect(await box(page).inputValue()).toBe('config');
  });
});

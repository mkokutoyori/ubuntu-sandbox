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

async function poserPoste(page: Page): Promise<string> {
  return page.evaluate(() => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const created = store.getState().addDevice('linux-pc', 140, 240);
    const device = store.getState().deviceInstances.get(created.id) as Record<string, unknown>;
    (device.powerOn as (() => void) | undefined)?.call(device);
    return created.id;
  });
}

async function cabler(page: Page, fw: string, pc: string): Promise<void> {
  await page.evaluate(({ a, b }) => {
    type S = {
      addConnection(x: string, xi: string, y: string, yi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    store.getState().addConnection(a, 'port1', b, 'eth0', 'ethernet');
  }, { a: fw, b: pc });
  await page.waitForTimeout(500);
}

async function fermerTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]')
    .waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForTimeout(300);
}

async function entrer(page: Page, ligne: string): Promise<void> {
  const input = box(page);
  await input.focus();
  await input.fill(ligne);
  await input.press('Enter');
  await page.waitForTimeout(300);
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

  test('les memes raccourcis a travers une vraie session SSH', async ({ page }) => {
    const fw = await poserFortiGate(page);
    const pc = await poserPoste(page);
    await cabler(page, fw, pc);

    await openTerminal(page, fw);
    for (const ligne of [
      'config system interface', 'edit "port1"', 'set mode static',
      'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping ssh', 'next', 'end',
      'config system admin', 'edit "admin"',
      'set password "Secret123"', 'set accprofile "super_admin"', 'next', 'end',
    ]) await entrer(page, ligne);
    await fermerTerminal(page);

    await page.locator(`[data-device-id="${pc}"]`).first().dblclick({ timeout: 8_000 });
    await page.locator('[data-testid="terminal-modal"]')
      .waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(1200);

    await entrer(page, 'ip link set eth0 up');
    await entrer(page, 'ip addr add 192.168.1.10/24 dev eth0');
    await entrer(page, 'ssh admin@192.168.1.1');
    const secret = page.locator('[data-testid="terminal-modal"] input[type="password"]');
    await secret.waitFor({ state: 'visible', timeout: 15_000 });
    await secret.focus();
    await secret.fill('Secret123');
    await secret.press('Enter');
    await page.waitForTimeout(800);
    await expect.poll(
      async () => /^\S+ #/m.test(
        await page.locator('[data-testid="terminal-modal"]').innerText()),
      { timeout: 15_000 }).toBe(true);

    await tape(page, 'get system statXus');
    await touche(page, 'Control+a');
    expect(await caret(page)).toBe(0);
    for (let i = 0; i < 15; i++) await touche(page, 'Control+f');
    await touche(page, 'Control+d');
    expect(await box(page).inputValue()).toBe('get system status');

    await touche(page, 'Control+e');
    await box(page).press('Enter');
    await expect.poll(
      async () => (await page.locator('[data-testid="terminal-modal"]').innerText())
        .includes('Serial-Number:'), { timeout: 15_000 }).toBe(true);
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

import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(1500);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(300);
}

async function typePassword(page: Page, secret: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]').last();
  await input.focus();
  await input.fill(secret);
  await input.press('Enter');
  await page.waitForTimeout(400);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 10_000): Promise<void> {
  await expect.poll(async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

async function poserRouteur(page: Page): Promise<string> {
  return page.evaluate(() => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const r = store.getState().addDevice('router-cisco', 300, 250);
    const dev = store.getState().deviceInstances.get(r.id) as Record<string, unknown>;
    (dev.powerOn as (() => void) | undefined)?.call(dev);
    return r.id;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('La console n\'est pas une VTY, et SSH ne parle pas pour elle', () => {
  test('login console : aucun message SSH, `show users` sur `con 0`, historique propre', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserRouteur(page);
    await openTerminal(page, id);

    for (const c of ['enable', 'configure terminal',
      'username alice privilege 15 secret cisco',
      'username bob privilege 15 secret cisco',
      'line console 0', 'login local', 'end']) {
      await typeCmd(page, c);
    }

    await typeCmd(page, 'exit');
    await waitForText(page, 'con0 is now available');
    await typeCmd(page, '');
    await waitForText(page, 'Username:');
    await typeCmd(page, 'alice');
    await typePassword(page, 'cisco');
    await page.waitForTimeout(500);

    const apresLogin = await modalText(page);
    expect(apresLogin, 'SSH ne parle pas pour la console').not.toContain('SSH2_SESSION');
    expect(apresLogin).not.toMatch(/on vty \d+ from console/);

    await typeCmd(page, 'show clock');
    await typeCmd(page, 'show users');
    await waitForText(page, 'con 0');
    const vuAlice = await modalText(page);
    expect(vuAlice, 'alice tient la console, pas une ligne virtuelle')
      .not.toMatch(/vty \d+\s+alice/);

    await typeCmd(page, 'exit');
    await waitForText(page, 'con0 is now available');
    await typeCmd(page, '');
    await waitForText(page, 'Username:');
    await typeCmd(page, 'bob');
    await typePassword(page, 'cisco');
    await page.waitForTimeout(500);

    await typeCmd(page, 'show users');
    await page.waitForTimeout(400);
    const vuBob = await modalText(page);
    const derniereTable = vuBob.slice(vuBob.lastIndexOf('Line       User'));
    expect(derniereTable, 'bob est la').toContain('bob');
    expect(derniereTable, 'alice est partie').not.toContain('alice');

    await typeCmd(page, 'show history');
    await page.waitForTimeout(400);
    const finalText = await modalText(page);
    const apresShowHistory = finalText.slice(finalText.lastIndexOf('show history') + 'show history'.length);
    expect(apresShowHistory, 'la commande d\'alice n\'appartient pas a bob')
      .not.toContain('show clock');
  });
});

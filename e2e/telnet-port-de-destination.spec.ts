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
  await page.waitForTimeout(400);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function poserPoste(page: Page): Promise<string> {
  return page.evaluate(() => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const created = store.getState().addDevice('linux-pc', 320, 240);
    const device = store.getState().deviceInstances.get(created.id) as Record<string, unknown>;
    (device.powerOn as (() => void) | undefined)?.call(device);
    return created.id;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('telnet — un port de destination est un PORT', () => {
  test('un port hors des bornes est refuse plutot que compose', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserPoste(page);
    await openTerminal(page, id);

    await typeCmd(page, 'telnet 10.0.0.2 99999');

    const texte = await modalText(page);
    expect(texte).toMatch(/usage: telnet/);
    expect(texte).not.toMatch(/Trying/);
  });

  test('le port zero est refuse de meme', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserPoste(page);
    await openTerminal(page, id);

    await typeCmd(page, 'telnet 10.0.0.2 0');

    expect(await modalText(page)).toMatch(/usage: telnet/);
  });

  test('un port valide est bien compose', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserPoste(page);
    await openTerminal(page, id);

    await typeCmd(page, 'telnet 10.0.0.2 23');

    expect(await modalText(page)).not.toMatch(/usage: telnet/);
  });
});

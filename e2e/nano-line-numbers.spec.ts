import { test, expect, type Page } from '@playwright/test';
import { nanoRows } from './helpers/nanoScreen';

/**
 * Scénario (e2e) — numéros de ligne dans nano : `nano -l` les affiche à
 * l'ouverture, M-# les bascule à la volée. Aucun des deux n'existait —
 * pas d'équivalent à la gouttière déjà présente dans VimEditor.
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}
async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(t, 400, 300).id;
  }, type);
}
async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}
async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(250);
}

test.describe('Scénario (e2e) — numéros de ligne dans nano', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('aucune gouttière par défaut, `nano -l` en affiche une dès l\'ouverture', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/nolines.txt');
    await expect(page.getByText('GNU nano')).toBeVisible({ timeout: 5_000 });
    expect((await nanoRows(page))[0]).not.toMatch(/^\s*1 /);
    await page.keyboard.press('Control+x');

    await typeCmd(page, 'printf "a\\nb\\nc\\n" > /tmp/lines.txt');
    await typeCmd(page, 'nano -l /tmp/lines.txt');
    await expect.poll(async () => (await nanoRows(page)).slice(0, 3)).toEqual([' 1 a', ' 2 b', ' 3 c']);
  });

  test('M-# bascule la gouttière à la volée', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/toggle.txt');
    await expect(page.locator('[data-testid="nano-body"]')).toBeVisible({ timeout: 5_000 });
    await page.keyboard.type('a');
    expect((await nanoRows(page))[0]).toBe('a');

    await page.keyboard.press('Alt+Shift+3');
    await expect.poll(async () => (await nanoRows(page))[0]).toBe(' 1 a');

    await page.keyboard.press('Alt+Shift+3');
    await expect.poll(async () => (await nanoRows(page))[0]).toBe('a');
  });
});

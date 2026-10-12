import { test, expect, type Page } from '@playwright/test';
import { nanoCursor } from './helpers/nanoScreen';

/**
 * Scénario (e2e) — le curseur de nano est la cellule `nano-cursor` du moteur : il se déplace
 * avec la position réelle, vit sur la rangée d'invite pendant un prompt, et reste visible en
 * mode vue (-v).
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

test.describe('Scénario (e2e) — curseur visible dans le buffer nano', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('la cellule du curseur existe et se déplace avec la position réelle du curseur', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/caret.txt');
    await expect(page.locator('[data-testid="nano-body"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="nano-cursor"]')).toBeVisible();

    await page.keyboard.type('ab');
    const afterAB = await nanoCursor(page);
    expect(afterAB).toEqual({ row: 1, column: 2 });

    await page.keyboard.press('Home');
    expect(await nanoCursor(page)).toEqual({ row: 1, column: 0 });
  });

  test('pendant un prompt, le curseur est sur la rangée d\'invite, à la fin de la réponse', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/caret2.txt');
    await expect(page.locator('[data-testid="nano-body"]')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Control+w');
    await page.keyboard.type('abc');
    const status = page.locator('[data-testid="nano-status-message"]');
    await expect(status).toContainText('Search: abc');
    const cursor = await nanoCursor(page);
    expect(cursor.column).toBe('Search: abc'.length);
  });

  test('le curseur reste visible en mode vue (-v), lecture seule ou pas', async ({ page }) => {
    await typeCmd(page, 'echo "abc" > /tmp/caret3.txt');
    await typeCmd(page, 'nano -v /tmp/caret3.txt');
    await expect(page.locator('[data-testid="nano-body"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="nano-cursor"]')).toBeVisible();
  });
});

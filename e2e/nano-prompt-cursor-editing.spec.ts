import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario (e2e) — édition curseur dans les champs de prompt nano
 * (recherche, nom de fichier). Auparavant seul "taper en fin de champ +
 * Backspace en fin de champ" fonctionnait ; impossible de corriger une
 * faute de frappe au milieu sans tout retaper.
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

test.describe('Scénario (e2e) — édition curseur dans les champs de prompt nano', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('ArrowLeft dans le prompt de recherche insère la correction au bon endroit', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/promptcursor.txt');
    await expect(page.getByText('GNU nano')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Control+w');
    await page.keyboard.type('eth1');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('X');

    const searchInput = page.locator('[data-testid="nano-status-message"] input').first();
    await expect(searchInput).toHaveValue('ethX1');
  });

  test('Home puis Delete corrige le début d\'un nom de fichier sans tout retaper', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/promptcursor2.txt');
    await expect(page.getByText('GNU nano')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('x');
    await page.keyboard.press('Control+o');
    const filenameInput = page.locator('[data-testid="nano-status-message"] input').first();
    for (let i = 0; i < 40; i++) await page.keyboard.press('Backspace');
    await page.keyboard.type('//tmp/real.txt');
    await page.keyboard.press('Home');
    await page.keyboard.press('Delete');
    await expect(filenameInput).toHaveValue('/tmp/real.txt');

    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="nano-status-message"]')).toContainText('Wrote');
  });
});

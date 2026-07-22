import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario (e2e) — sélection de région dans nano : ^6/M-A pose une
 * marque, M-6 copie la région, ^K la coupe au lieu de la ligne entière.
 * Aucun des trois n'était lié auparavant — seul le ^K "ligne entière"
 * existait.
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

test.describe('Scénario (e2e) — sélection de région dans nano', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('^6 puis M-6 copie exactement le texte marqué, pas la ligne entière', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/mark.txt');
    const textarea = page.locator('[data-testid="nano-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('hello world');
    await page.keyboard.press('Home');
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+6');
    const status = page.locator('[data-testid="nano-status-message"]');
    await expect(status).toContainText('Mark Set');

    await page.keyboard.press('End');
    await page.keyboard.press('Alt+6');
    await expect(status).toContainText('Copied region');

    await page.keyboard.press('Home');
    await page.keyboard.press('Control+u');

    await expect(textarea).toHaveValue('worldhello world');
  });

  test('^K avec une marque active coupe la région, pas la ligne', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/mark2.txt');
    const textarea = page.locator('[data-testid="nano-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('hello world');
    await page.keyboard.press('Home');
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+6');
    await page.keyboard.press('End');
    await page.keyboard.press('Control+k');

    await expect(textarea).toHaveValue('hello ');

    await page.keyboard.press('Control+u');
    await expect(textarea).toHaveValue('hello world');
  });
});

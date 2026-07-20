import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario (e2e) — Ctrl+←/→ (saut par mot) et M-\ / M-/ (début/fin de
 * fichier) dans nano. Aucun des deux n'était lié auparavant.
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

test.describe('Scénario (e2e) — saut par mot et début/fin de fichier dans nano', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('Ctrl+→ saute au début du mot suivant, insère au bon endroit', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/word.txt');
    const textarea = page.locator('[data-testid="nano-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('foo bar baz');
    await page.keyboard.press('Home');
    await page.keyboard.press('Control+ArrowRight');
    await page.keyboard.type('-X-');

    await expect(textarea).toHaveValue('foo -X-bar baz');
  });

  test('Ctrl+← saute au début du mot précédent', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/word2.txt');
    const textarea = page.locator('[data-testid="nano-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('foo bar baz');
    await page.keyboard.press('Control+ArrowLeft');
    await page.keyboard.type('-X-');

    await expect(textarea).toHaveValue('foo bar -X-baz');
  });

  test('M-\\ va au début du fichier, M-/ va à la fin', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/fileends.txt');
    const textarea = page.locator('[data-testid="nano-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('alpha');
    await page.keyboard.press('Enter');
    await page.keyboard.type('beta');

    await page.keyboard.press('Alt+\\');
    await page.keyboard.type('X');
    await expect(textarea).toHaveValue('Xalpha\nbeta');

    await page.keyboard.press('Alt+/');
    await page.keyboard.type('Y');
    await expect(textarea).toHaveValue('Xalpha\nbetaY');
  });
});

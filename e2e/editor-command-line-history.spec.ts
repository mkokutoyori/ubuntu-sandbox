import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 15 (e2e) — Rappel d'historique via Haut/Bas, piloté depuis
 * la vraie UI terminal : `:` de vim et `Search:` de nano. Vérifié
 * directement sur la valeur affichée dans le champ de saisie de la
 * ligne de commande / recherche, pas seulement sur un effet indirect.
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
async function typeText(page: Page, text: string): Promise<void> {
  for (const ch of text) {
    await page.evaluate((c) => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: c, bubbles: true, cancelable: true }));
    }, ch);
  }
}
async function clearPromptField(page: Page, maxLen = 64): Promise<void> {
  for (let i = 0; i < maxLen; i++) await page.keyboard.press('Backspace');
}

test.describe('Scénario 15 (e2e) — rappel d\'historique Haut/Bas', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('vim : Haut/Haut dans : recule à travers deux commandes précédentes', async ({ page }) => {
    await typeCmd(page, "printf 'one\\ntwo\\n' > /tmp/vim-hist-e2e.txt");
    await typeCmd(page, 'vim /tmp/vim-hist-e2e.txt');
    await expect(page.getByText('vim-hist-e2e.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press(':');
    await typeText(page, 'set number');
    await page.keyboard.press('Enter');

    await page.keyboard.press(':');
    await typeText(page, 'set list');
    await page.keyboard.press('Enter');

    const cmdInput = page.locator('[data-testid="terminal-modal"] input').last();
    await page.keyboard.press(':');
    await page.keyboard.press('ArrowUp');
    await expect(cmdInput).toHaveValue('set list');
    await page.keyboard.press('ArrowUp');
    await expect(cmdInput).toHaveValue('set number');
    await page.keyboard.press('Escape');

    await page.keyboard.press(':');
    await typeText(page, 'q');
    await page.keyboard.press('Enter');
  });

  test('nano : Haut/Haut dans Search: recule à travers deux termes cherchés précédents', async ({ page }) => {
    await typeCmd(page, "printf 'alpha\\nbeta\\ngamma\\n' > /tmp/nano-hist-e2e.txt");
    await typeCmd(page, 'nano /tmp/nano-hist-e2e.txt');
    await expect(page.locator('[data-testid="nano-titlebar"]')).toContainText('nano-hist-e2e.txt', { timeout: 5_000 });

    await page.keyboard.press('Control+w');
    await typeText(page, 'alpha');
    await page.keyboard.press('Enter');

    await page.keyboard.press('Control+w');
    await clearPromptField(page);
    await typeText(page, 'gamma');
    await page.keyboard.press('Enter');

    const searchInput = page.locator('[data-testid="terminal-modal"] input').last();
    await page.keyboard.press('Control+w');
    await expect(searchInput).toHaveValue('gamma');
    await page.keyboard.press('ArrowUp');
    await expect(searchInput).toHaveValue('gamma');
    await page.keyboard.press('ArrowUp');
    await expect(searchInput).toHaveValue('alpha');

    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+x');
    await expect(page.locator('[data-testid="nano-titlebar"]')).not.toBeVisible({ timeout: 5_000 });
  });
});

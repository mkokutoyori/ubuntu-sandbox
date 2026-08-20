import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario UI-9 (e2e) — Affichage des caractères spéciaux dans les
 * éditeurs : avertissement de fichier binaire (vim), affichage `:set
 * list` (tabs/EOL), et notation `^X` pour les caractères de contrôle
 * dans nano.
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
async function exCmd(page: Page, cmd: string): Promise<void> {
  await page.keyboard.press(':');
  await typeText(page, cmd);
  await page.keyboard.press('Enter');
}

test.describe('Scénario UI-9 (e2e) — caractères spéciaux et encodage', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('vim avertit avant d\'ouvrir un fichier binaire, et "n" quitte sans jamais éditer', async ({ page }) => {
    await typeCmd(page, "printf 'ELF\\x00\\x00header\\n' > /tmp/fake-binary.bin");
    await typeCmd(page, 'vim /tmp/fake-binary.bin');
    await expect(page.getByText('may be a binary file')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('n');
    await expect(page.locator('[data-testid="terminal-modal"]')).not.toContainText('may be a binary file', { timeout: 5_000 });
    await expect(page.locator('[data-testid="vim-statusline"]')).not.toBeVisible();
  });

  test(':set list révèle $ (fin de ligne) et ^I (tabulation), invisibles sans list', async ({ page }) => {
    await typeCmd(page, "printf 'a\\tb\\n' > /tmp/list-mode.txt");
    await typeCmd(page, 'vim /tmp/list-mode.txt');
    await expect(page.getByText('list-mode.txt', { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('a^Ib$')).not.toBeVisible();

    await exCmd(page, 'set list');
    await expect(page.getByText('a^Ib$')).toBeVisible({ timeout: 5_000 });

    await exCmd(page, 'set nolist');
    await expect(page.getByText('a^Ib$')).not.toBeVisible();
  });

  test('nano affiche les caractères de contrôle en notation ^X, jamais bruts', async ({ page }) => {
    await typeCmd(page, "printf 'texte\\x01control\\x02ici\\n' > /tmp/ctrl-e2e.txt");
    await typeCmd(page, 'nano /tmp/ctrl-e2e.txt');
    await expect(page.locator('[data-testid="nano-titlebar"]')).toContainText('ctrl-e2e.txt', { timeout: 5_000 });
    await expect(page.getByText('texte^Acontrol^Bici')).toBeVisible({ timeout: 5_000 });
  });
});

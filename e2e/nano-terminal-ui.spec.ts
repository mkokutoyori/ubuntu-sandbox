import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario UI-1 (e2e) — Interface initiale de nano : barre de titre,
 * zone d'édition, barre de commandes.
 * Scénario UI-4 (e2e) — Barre de commandes nano contextuelle.
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

test.describe('Scénario UI-1/UI-4 (e2e) — interface nano', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('barre de titre : chemin complet centré, aucun statut sur fichier non modifié', async ({ page }) => {
    await typeCmd(page, 'echo "pc-linux-1" > /etc/hostname');
    await typeCmd(page, 'nano /etc/hostname');
    const titlebar = page.locator('[data-testid="nano-titlebar"]');
    await expect(titlebar).toBeVisible({ timeout: 5_000 });
    await expect(titlebar).toContainText('GNU nano');
    await expect(titlebar).toContainText('/etc/hostname');
    await expect(titlebar).not.toContainText('Modified');
  });

  test('barre de titre affiche "Modified" après une frappe, disparaît après sauvegarde', async ({ page }) => {
    await typeCmd(page, 'echo "line1" > /tmp/nano-title-test.txt');
    await typeCmd(page, 'nano /tmp/nano-title-test.txt');
    const titlebar = page.locator('[data-testid="nano-titlebar"]');
    await expect(titlebar).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('End');
    await page.keyboard.press('x');
    await expect(titlebar).toContainText('Modified');

    await page.keyboard.press('Control+o');
    await page.keyboard.press('Enter');
    await expect(titlebar).not.toContainText('Modified');
  });

  test('nano -v ouvre en lecture seule : "[view]" dans le titre, barre de commandes réduite, frappe sans effet', async ({ page }) => {
    await typeCmd(page, 'echo "secret" > /tmp/nano-readonly.txt');
    await typeCmd(page, 'nano -v /tmp/nano-readonly.txt');
    const titlebar = page.locator('[data-testid="nano-titlebar"]');
    await expect(titlebar).toBeVisible({ timeout: 5_000 });
    await expect(titlebar).toContainText('[view]');

    const shortcutBar = page.locator('[data-testid="nano-shortcut-bar"]');
    await expect(shortcutBar).not.toContainText('Write Out');

    await page.keyboard.type('HACKED');
    await expect(titlebar).not.toContainText('Modified');

    await page.keyboard.press('Control+x');
    await expect(page.locator('[data-testid="nano-titlebar"]')).not.toBeVisible({ timeout: 5_000 });
  });

  test('la barre de commandes change en mode recherche puis revient à la normale après Échap', async ({ page }) => {
    await typeCmd(page, 'echo "abc" > /tmp/nano-search-bar.txt');
    await typeCmd(page, 'nano /tmp/nano-search-bar.txt');
    await expect(page.locator('[data-testid="nano-shortcut-bar"]')).toContainText('Write Out', { timeout: 5_000 });

    await page.keyboard.press('Control+w');
    const shortcutBar = page.locator('[data-testid="nano-shortcut-bar"]');
    await expect(shortcutBar).toContainText('Search');
    await expect(shortcutBar).toContainText('Regexp');
    await expect(shortcutBar).not.toContainText('Write Out');

    await page.keyboard.press('Escape');
    await expect(shortcutBar).toContainText('Write Out');
    await expect(shortcutBar).not.toContainText('Regexp');
  });
});

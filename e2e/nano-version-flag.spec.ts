import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario (e2e) — `nano --version` / `-V` doivent imprimer la bannière
 * de version dans le terminal et revenir au prompt, PAS ouvrir
 * l'éditeur. openEditor() traitait tout argument `-x` comme "pas de nom
 * de fichier" et ouvrait un buffer vide sans nom à la place.
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

test.describe('Scénario (e2e) — `nano --version` imprime la bannière au lieu d\'ouvrir l\'éditeur', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('`nano --version` affiche la bannière et ne bascule pas dans l\'overlay éditeur', async ({ page }) => {
    await typeCmd(page, 'nano --version');
    await expect(page.getByText(/GNU nano, version 6\.2/)).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="nano-textarea"]')).toHaveCount(0);
  });

  test('`nano -V` (forme courte) a le même effet', async ({ page }) => {
    await typeCmd(page, 'nano -V');
    await expect(page.getByText(/GNU nano, version 6\.2/)).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="nano-textarea"]')).toHaveCount(0);
  });

  test('un vrai `nano fichier` juste après ouvre toujours bien l\'éditeur', async ({ page }) => {
    await typeCmd(page, 'nano --version');
    await typeCmd(page, 'nano /tmp/x.txt');
    await expect(page.locator('[data-testid="nano-textarea"]')).toBeVisible({ timeout: 5_000 });
  });
});

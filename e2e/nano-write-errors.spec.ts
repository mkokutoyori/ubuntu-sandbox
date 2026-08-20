import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario — échec d'écriture dans nano (permission refusée). Jusqu'ici
 * ^O / ^X→Y ignoraient le résultat de l'écriture disque et affichaient
 * toujours "[ Wrote N lines ]" même quand rien n'avait été écrit — perte
 * de données silencieuse. Ce spec exerce le vrai chemin de permissions
 * (utilisateur non privilégié `user` face à /etc, root:root 0755) via
 * l'UI complète.
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

test.describe('Scénario (e2e) — nano et échec d\'écriture (permission refusée)', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('^O sur un fichier système sans permission affiche une erreur, le buffer reste modifié', async ({ page }) => {
    await typeCmd(page, 'nano /etc/fstab');
    const titlebar = page.locator('[data-testid="nano-titlebar"]');
    await expect(titlebar).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('tmpfs /mnt/ramtest tmpfs defaults 0 0');
    await expect(titlebar).toContainText('Modified');

    await page.keyboard.press('Control+o');
    await page.keyboard.press('Enter');

    const status = page.locator('[data-testid="nano-status-message"]');
    await expect(status).toContainText('Error writing /etc/fstab');
    await expect(titlebar).toContainText('Modified');
  });

  test('^X puis Y sur le même fichier n\'exécute pas la sortie : nano reste ouvert', async ({ page }) => {
    await typeCmd(page, 'nano /etc/fstab');
    const titlebar = page.locator('[data-testid="nano-titlebar"]');
    await expect(titlebar).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('tmpfs /mnt/ramtest tmpfs defaults 0 0');
    await page.keyboard.press('Control+x');
    await page.keyboard.press('y');
    // Real nano always chains to "File Name to Write:" here, exactly
    // like a plain ^O -- it never writes directly.
    const status = page.locator('[data-testid="nano-status-message"]');
    await expect(status).toContainText('File Name to Write');
    await page.keyboard.press('Enter');

    // Real nano stays in the buffer on a write failure — the editor
    // overlay must NOT have closed.
    await expect(titlebar).toBeVisible();
    await expect(status).toContainText('Error writing /etc/fstab');
  });
});

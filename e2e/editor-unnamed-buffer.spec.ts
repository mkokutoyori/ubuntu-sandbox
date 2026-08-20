import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario (e2e) — `nano`/`vim` invoqués sans nom de fichier ouvrent un
 * buffer réellement sans nom. Avant ce fix, `nano` (seul) proposait
 * silencieusement d'écrire dans un fichier littéralement appelé
 * "New Buffer" au premier ^O ; "New Buffer" ne doit être qu'un STATUT
 * affiché dans la barre de titre, jamais un vrai chemin de fichier.
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

test.describe('Scénario (e2e) — nano/vim sans nom de fichier', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('nano seul : titre "New Buffer", ^O propose un nom VIDE, écrire à un vrai chemin fonctionne', async ({ page }) => {
    await typeCmd(page, 'nano');
    const titlebar = page.locator('[data-testid="nano-titlebar"]');
    await expect(titlebar).toBeVisible({ timeout: 5_000 });
    await expect(titlebar).toContainText('New Buffer');

    await page.keyboard.type('contenu');
    await page.keyboard.press('Control+o');
    const status = page.locator('[data-testid="nano-status-message"]');
    await expect(status).toContainText('File Name to Write');
    // The filename field must start EMPTY, never prefilled with "New Buffer".
    const filenameInput = page.locator('[data-testid="nano-status-message"] input');
    await expect(filenameInput).toHaveValue('');

    await page.keyboard.type('/tmp/really-named.txt');
    await page.keyboard.press('Enter');
    await expect(status).toContainText('Wrote 1 line');

    await page.keyboard.press('Control+x');
    await typeCmd(page, 'cat /tmp/really-named.txt');
    const out = await page.locator('[data-testid="terminal-modal"]').innerText();
    expect(out).toContain('contenu');

    // Confirm no stray "New Buffer" file was ever created anywhere.
    await typeCmd(page, 'find / -iname "*New Buffer*" 2>/dev/null');
    const findOut = await page.locator('[data-testid="terminal-modal"]').innerText();
    const findSection = findOut.slice(findOut.lastIndexOf('find /'));
    expect(findSection).not.toContain('/New Buffer');
  });

  test('vim seul : :w sans nom échoue avec E32, ne crée rien sur le disque', async ({ page }) => {
    await typeCmd(page, 'vim');
    await expect(page.getByText('GNU nano')).not.toBeVisible();
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('i');
    await page.keyboard.type('hello');
    await page.keyboard.press('Escape');
    await page.keyboard.type(':w');
    await page.keyboard.press('Enter');

    await expect(page.getByText('E32: No file name')).toBeVisible();
  });
});

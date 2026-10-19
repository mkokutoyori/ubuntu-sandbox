import { test, expect, type Page } from '@playwright/test';
import { nanoText } from './helpers/nanoScreen';

/**
 * Scénario (e2e) — la barre de raccourcis de nano promettait des touches
 * mortes : ^G affichait la position du curseur au lieu d'ouvrir l'aide,
 * ^X puis Y à la sortie écrivait directement sans repasser par "File
 * Name to Write:", et ^T/^R/^J n'avaient aucun effet malgré leur
 * présence dans la barre. Ce spec vérifie chacun via l'UI réelle.
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

test.describe('Scénario (e2e) — barre de raccourcis nano : ^G, ^X→Y, ^T, ^R, ^J', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('^G ouvre un véritable écran d\'aide, ^X le referme', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/help.txt');
    await expect(page.locator('[data-testid="nano-body"]')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Control+g');
    const titlebar = page.locator('[data-testid="nano-titlebar"]');
    await expect(titlebar).toContainText('Main nano help text');
    await expect.poll(() => nanoText(page)).toMatch(/The nano editor is designed to emulate the functionality/);

    await page.keyboard.press('Control+x');
    await expect(titlebar).toContainText('GNU nano');
    await expect(titlebar).not.toContainText('Main nano help text');
  });

  test('^X puis Y repasse par "File Name to Write:" avant d\'écrire', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/exit-chain.txt');
    const body = page.locator('[data-testid="nano-body"]');
    await expect(body).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('contenu');
    await page.keyboard.press('Control+x');
    await page.keyboard.press('y');

    const status = page.locator('[data-testid="nano-status-message"]');
    await expect(status).toContainText('File Name to Write');
    await expect(body).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="nano-titlebar"]')).not.toBeVisible({ timeout: 5_000 });

    await typeCmd(page, 'cat /tmp/exit-chain.txt');
    const out = await page.locator('[data-testid="terminal-modal"]').innerText();
    expect(out).toContain('contenu');
  });

  test('^T Execute Command insère la sortie d\'une commande au curseur', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/exec.txt');
    await expect(page.locator('[data-testid="nano-body"]')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Control+t');
    const status = page.locator('[data-testid="nano-status-message"]');
    await expect(status).toContainText('Command to execute');

    await page.keyboard.type('echo INSERTED');
    await page.keyboard.press('Enter');

    await expect.poll(() => nanoText(page)).toMatch(/INSERTED/);
  });

  test('^J Justify reformate le paragraphe courant', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/justify.txt');
    await expect(page.locator('[data-testid="nano-body"]')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('alpha');
    await page.keyboard.press('Enter');
    await page.keyboard.type('beta');
    await page.keyboard.press('Enter');
    await page.keyboard.type('gamma');

    await page.keyboard.press('Control+j');
    await expect.poll(() => nanoText(page)).toBe('alpha beta gamma');
  });
});

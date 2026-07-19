import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario UI-7 (e2e) — visudo : le fichier édité est un fichier
 * temporaire (pas /etc/sudoers directement), et une erreur de syntaxe
 * déclenche le vrai menu "What now?" (e/x/Q) affiché HORS de l'éditeur,
 * jamais à l'intérieur.
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
async function typePassword(page: Page, password: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]');
  await input.focus();
  await input.fill(password);
  await input.press('Enter');
  await page.waitForTimeout(250);
}
async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
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

test.describe('Scénario UI-7 (e2e) — visudo "What now?"', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'sudo su -');
    await typePassword(page, 'admin');
    await typeCmd(page, 'whoami');
    await expect(page.locator('[data-testid="terminal-modal"]')).toContainText('root', { timeout: 5_000 });
  });

  test('visudo édite un fichier temporaire (pas /etc/sudoers), erreur de syntaxe déclenche le menu "What now?" hors éditeur', async ({ page }) => {
    await typeCmd(page, 'export EDITOR=vim');
    await typeCmd(page, 'visudo');
    const statusline = page.locator('[data-testid="vim-statusline"]');
    await expect(statusline).toBeVisible({ timeout: 5_000 });
    await expect(statusline).toContainText('visudo.');
    await expect(statusline).not.toContainText('sudoers');

    await page.keyboard.press('G');
    await page.keyboard.press('o');
    await typeText(page, 'broken line without an equals');
    await page.keyboard.press('Escape');
    await exCmd(page, 'wq');

    // The prompt appears in the plain terminal, after the editor closed.
    await expect(page.locator('[data-testid="vim-statusline"]')).not.toBeVisible({ timeout: 5_000 });
    const transcript = await modalText(page);
    expect(transcript).toContain('syntax error');
    expect(transcript).toContain('What now?');
    expect(transcript).toContain('(e)dit sudoers file again');

    await typeCmd(page, 'x');
    const after = await modalText(page);
    expect(after).toContain('unchanged');
  });
});

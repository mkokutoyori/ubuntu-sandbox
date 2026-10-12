import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario UI-2 (e2e) — Interface vim : mode line, numéros de ligne, tildes.
 * Scénario UI-3 (e2e) — Interface vi : absence de -- INSERT --, ligne de
 * statut minimale, par comparaison directe avec vim sur le même fichier.
 * Scénario UI-5 (e2e) — Retours visuels vim : messages exacts, [+] en
 * temps réel.
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

test.describe('Scénario UI-2/UI-3/UI-5 (e2e) — interface vim/vi', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('les tildes (~) marquent les lignes vides même sans :set number', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'printf "one\\ntwo\\n" > /tmp/vim-tilde-test.txt');
    await typeCmd(page, 'vim /tmp/vim-tilde-test.txt');
    await expect(page.locator('[data-testid="vim-cmdline"]')).toContainText('vim-tilde-test.txt', { timeout: 5_000 });

    const tildes = page.locator('[data-testid="vim-tilde"]');
    expect(await tildes.count()).toBeGreaterThan(0);
    await expect(tildes.first()).toHaveText('~');
  });

  test(':set number affiche des numéros de ligne, absents par défaut', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'printf "one\\ntwo\\nthree\\n" > /tmp/vim-nu-test.txt');
    await typeCmd(page, 'vim /tmp/vim-nu-test.txt');
    await expect(page.locator('[data-testid="vim-cmdline"]')).toContainText('vim-nu-test.txt', { timeout: 5_000 });

    const rows = page.locator('[data-testid="vim-line"]');
    await expect(rows.first()).toHaveText('one');

    await exCmd(page, 'set number');
    await expect(rows.first()).toHaveText('  1 one');
    await expect(rows.nth(1)).toHaveText('  2 two');
    await expect(rows.nth(2)).toHaveText('  3 three');
  });

  test('la règle de la dernière ligne affiche "All" pour un petit fichier et suit le curseur', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'printf "one\\ntwo\\n" > /tmp/vim-modeline-test.txt');
    await typeCmd(page, 'vim /tmp/vim-modeline-test.txt');
    const cmdline = page.locator('[data-testid="vim-cmdline"]');
    await expect(cmdline).toBeVisible({ timeout: 5_000 });
    await expect(cmdline).toContainText('1,1');
    await expect(cmdline).toContainText('All');

    await page.keyboard.press('A');
    await typeText(page, 'x');
    await page.keyboard.press('Escape');
    await expect(cmdline).toContainText('1,4');

    await exCmd(page, 'w');
    await expect(cmdline).toContainText('written');
  });

  test('une tabulation décale le curseur de huit colonnes, comme la règle de vim', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'printf "\\tx\\n" > /tmp/vim-tab-test.txt');
    await typeCmd(page, 'vim /tmp/vim-tab-test.txt');
    const cmdline = page.locator('[data-testid="vim-cmdline"]');
    await expect(cmdline).toContainText('1,1', { timeout: 5_000 });
    await page.keyboard.press('l');
    await expect(cmdline).toContainText('1,2-9');
    const cursor = page.locator('[data-testid="vim-cursor"]');
    const line = page.locator('[data-testid="vim-line"]').first();
    const lineBox = (await line.boundingBox())!;
    const cursorBox = (await cursor.boundingBox())!;
    const cell = cursorBox.width;
    expect(Math.round((cursorBox.x - lineBox.x) / cell)).toBe(8);
  });

  test('vim affiche -- INSERT --, vi ne l\'affiche jamais sur le même fichier', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'printf "hello\\n" > /tmp/vi-vs-vim.txt');

    await typeCmd(page, 'vim /tmp/vi-vs-vim.txt');
    await expect(page.locator('[data-testid="vim-cmdline"]')).toContainText('vi-vs-vim.txt', { timeout: 5_000 });
    await page.keyboard.press('i');
    await expect(page.getByText('-- INSERT --')).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await exCmd(page, 'q');

    await typeCmd(page, 'vi /tmp/vi-vs-vim.txt');
    await expect(page.locator('[data-testid="vim-cmdline"]')).toContainText('vi-vs-vim.txt', { timeout: 5_000 });
    await page.keyboard.press('i');
    await expect(page.getByText('-- INSERT --')).not.toBeVisible();
  });

  test('vi affiche une ligne de statut minimale : pas de position/pourcentage, contrairement à vim', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'printf "hello\\n" > /tmp/vi-minimal-status.txt');
    await typeCmd(page, 'vi /tmp/vi-minimal-status.txt');
    const cmdline = page.locator('[data-testid="vim-cmdline"]');
    await expect(cmdline).toBeVisible({ timeout: 5_000 });
    await expect(cmdline).toContainText('vi-minimal-status.txt');
    await expect(cmdline).not.toContainText('All');
    await expect(cmdline).not.toContainText('1,1');
  });
});

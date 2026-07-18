import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 8 (e2e) — Récupération depuis un fichier swap vim après
 * interruption, pilotée depuis la vraie UI terminal. "kill -9" is
 * modelled by closing the terminal window without ever running :q —
 * the VimEditor React component unmounts (the "process" dies) while
 * the device's VFS survives (the "disk" survives), exactly like a
 * real OS outliving a killed process.
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

test.describe('Scénario 8 (e2e) — récupération swap vim après interruption', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('swap créé à l\'ouverture, survit à un "kill", puis R récupère les modifications non sauvegardées', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);

    await typeCmd(page, 'echo "Contenu original" > /tmp/vim-swap-test.txt');
    await typeCmd(page, 'vim /tmp/vim-swap-test.txt');
    await expect(page.getByText('vim-swap-test.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('A');
    await typeText(page, ' MODIFIE');
    await page.keyboard.press('Escape');

    // "kill -9": close the terminal window without :q.
    await page.getByTitle('Close').first().click();
    await page.waitForTimeout(300);

    // Reopen a fresh terminal on the SAME device and re-run vim on the
    // same file — the device (and its VFS) survived the "kill".
    await openTerminal(page, id);
    await typeCmd(page, 'find /tmp -name "*.swp"');
    const findOut = await modalText(page);
    expect(findOut).toContain('.vim-swap-test.txt.swp');

    await typeCmd(page, 'vim /tmp/vim-swap-test.txt');
    await expect(page.getByText('E325: ATTENTION')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/\(R\)ecover/)).toBeVisible();

    await page.keyboard.press('R');
    await expect(page.getByText('E325: ATTENTION')).not.toBeVisible();

    await page.keyboard.press(':');
    await typeText(page, 'wq');
    await page.keyboard.press('Enter');

    await typeCmd(page, 'cat /tmp/vim-swap-test.txt');
    const transcript = await modalText(page);
    const catOut = transcript.slice(transcript.lastIndexOf('cat /tmp/vim-swap-test.txt'));
    expect(catOut).toContain('Contenu original MODIFIE');

    // The recovery-source .swp is an orphan — a real, explicit cleanup
    // requirement, not auto-removed.
    await typeCmd(page, 'find /tmp -name "*.swp"');
    const swpAfter = await modalText(page);
    expect(swpAfter.slice(swpAfter.lastIndexOf('find /tmp -name'))).toContain('.vim-swap-test.txt.swp');
  });
});

import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario (e2e) — "Replace this instance?" surligne désormais
 * l'occurrence concernée. Le moteur exposait déjà `pendingReplaceMatch`
 * mais rien ne l'affichait : l'utilisateur devait deviner quelle
 * occurrence était en train d'être proposée pour Y/N/A.
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

test.describe('Scénario (e2e) — surlignage de "Replace this instance?"', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('aucun surlignage hors de "Replace this instance?", puis un overlay apparaît sur la bonne occurrence', async ({ page }) => {
    await typeCmd(page, 'echo "eth0 up" > /tmp/nano-hl.txt');
    await typeCmd(page, 'nano /tmp/nano-hl.txt');
    await expect(page.getByText('GNU nano')).toBeVisible({ timeout: 5_000 });

    const highlight = page.locator('[data-testid="nano-replace-highlight"]');
    await expect(highlight).toHaveCount(0);

    await page.keyboard.press('Control+\\');
    await typeText(page, 'eth');
    await page.keyboard.press('Enter');
    await typeText(page, 'ens');
    await page.keyboard.press('Enter');

    await expect(page.getByText('Replace this instance?')).toBeVisible();
    await expect(highlight).toBeVisible();

    // Cancel out without writing -- this test only cares about the overlay.
    await page.keyboard.press('Control+c');
    await expect(highlight).toHaveCount(0);
  });
});

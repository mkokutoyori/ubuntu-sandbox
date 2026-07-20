import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario (e2e) — `nano +N fichier` / `vim +N fichier` positionnent le
 * curseur à la ligne N dès l'ouverture. L'argument était déjà filtré du
 * nom de fichier mais silencieusement jeté sans jamais bouger le
 * curseur.
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

test.describe('Scénario (e2e) — nano/vim +N ouvre directement à la ligne N', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('nano +20 place le curseur ligne 20, la frappe suivante s\'insère là', async ({ page }) => {
    await typeCmd(page, 'for i in $(seq 1 40); do echo "line $i" >> /tmp/plusn.txt; done');
    await typeCmd(page, 'nano +20 /tmp/plusn.txt');
    const textarea = page.locator('[data-testid="nano-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('-HERE-');
    await expect(textarea).toHaveValue(/-HERE-line 20/);
  });

  test('vim +10 place le curseur ligne 10', async ({ page }) => {
    await typeCmd(page, 'for i in $(seq 1 40); do echo "line $i" >> /tmp/plusn2.txt; done');
    await typeCmd(page, 'vim +10 /tmp/plusn2.txt');
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('i');
    await page.keyboard.type('-HERE-');
    await page.keyboard.press('Escape');
    await expect(textarea).toHaveValue(/-HERE-line 10/);
  });
});

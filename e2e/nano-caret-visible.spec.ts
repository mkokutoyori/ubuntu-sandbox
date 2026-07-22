import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario (e2e) — le curseur doit être visible dans le buffer nano. Le
 * textarea principal est délibérément `readOnly` (le moteur reste seul
 * maître de l'édition) — mais Chromium ne rend JAMAIS de curseur
 * clignotant natif sur un textarea readOnly, quels que soient
 * `caretColor`/`selectionRange`. Un overlay dédié (positionné en ch/em,
 * comme le surlignage de "Replace this instance?") comble ce manque.
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

test.describe('Scénario (e2e) — curseur visible dans le buffer nano', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('un overlay de curseur existe et se déplace avec la position réelle du curseur', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/caret.txt');
    const textarea = page.locator('[data-testid="nano-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 5_000 });

    const caret = page.locator('[data-testid="nano-caret"]');
    await expect(caret).toBeVisible();

    await page.keyboard.type('ab');
    const boxAfterAB = await caret.boundingBox();

    await page.keyboard.press('Home');
    const boxAtHome = await caret.boundingBox();

    expect(boxAtHome).not.toBeNull();
    expect(boxAfterAB).not.toBeNull();
    // Home moves the caret strictly left of where it was after typing "ab".
    expect(boxAtHome!.x).toBeLessThan(boxAfterAB!.x);
  });

  test('aucun overlay de curseur pendant un prompt (le vrai curseur du champ suffit)', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/caret2.txt');
    await expect(page.locator('[data-testid="nano-textarea"]')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Control+w');
    await expect(page.locator('[data-testid="nano-caret"]')).toHaveCount(0);
  });

  test('le curseur reste visible en mode vue (-v), lecture seule ou pas', async ({ page }) => {
    await typeCmd(page, 'echo "abc" > /tmp/caret3.txt');
    await typeCmd(page, 'nano -v /tmp/caret3.txt');
    await expect(page.locator('[data-testid="nano-textarea"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="nano-caret"]')).toBeVisible();
  });
});

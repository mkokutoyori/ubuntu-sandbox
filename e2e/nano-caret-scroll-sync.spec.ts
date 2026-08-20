import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario (e2e) — le curseur (et le surlignage de remplacement, et la
 * gouttière de numéros de ligne) doivent suivre le défilement du
 * textarea. L'overlay du curseur (`nano-caret`, ajouté pour compenser
 * l'absence de curseur natif Chromium sur un textarea readOnly) était
 * positionné uniquement à partir de `cursorLine`/`cursorCol` — un
 * simple défilement à la molette (qui ne change aucun état du moteur,
 * donc ne redessine rien) le laissait figé à sa position d'origine,
 * flottant au-dessus du texte réellement affiché.
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

test.describe('Scénario (e2e) — le curseur nano suit le défilement du buffer', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('un défilement molette (sans bouger le curseur) déplace l\'overlay du curseur d\'autant', async ({ page }) => {
    await typeCmd(page, 'for i in $(seq 1 80); do echo "line $i" >> /tmp/scroll.txt; done');
    await typeCmd(page, 'nano /tmp/scroll.txt');
    const textarea = page.locator('[data-testid="nano-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    const caret = page.locator('[data-testid="nano-caret"]');
    await expect(caret).toBeVisible();

    const boxBefore = await caret.boundingBox();
    expect(boxBefore).not.toBeNull();

    // Wheel-scroll the textarea's content down without moving the cursor
    // (the cursor is still at line 1 — this is a pure viewport scroll).
    await textarea.hover();
    const delta = 120;
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(100);

    const boxAfter = await caret.boundingBox();
    expect(boxAfter).not.toBeNull();
    // The caret must move UP on screen by (about) the scroll delta —
    // before the fix it stayed at boxBefore's position (delta ~ 0).
    expect(boxBefore!.y - boxAfter!.y).toBeGreaterThan(delta - 20);
  });

  test('la gouttière de numéros de ligne suit aussi le défilement', async ({ page }) => {
    await typeCmd(page, 'for i in $(seq 1 80); do echo "line $i" >> /tmp/scroll2.txt; done');
    await typeCmd(page, 'nano -l /tmp/scroll2.txt');
    const textarea = page.locator('[data-testid="nano-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    const gutter = page.locator('[data-testid="nano-gutter"]');
    await expect(gutter).toBeVisible();

    const boxBefore = await gutter.boundingBox();
    expect(boxBefore).not.toBeNull();

    await textarea.hover();
    const delta = 120;
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(100);

    const boxAfter = await gutter.boundingBox();
    expect(boxAfter).not.toBeNull();
    expect(boxBefore!.y - boxAfter!.y).toBeGreaterThan(delta - 20);
  });
});

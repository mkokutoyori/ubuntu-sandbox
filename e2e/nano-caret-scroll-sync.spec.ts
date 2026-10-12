import { test, expect, type Page } from '@playwright/test';
import { nanoRows, nanoCursor } from './helpers/nanoScreen';

/**
 * Scénario (e2e) — la fenêtre de nano défile à la molette de trois lignes, et le curseur,
 * la gouttière des numéros de ligne et les rangées restent cohérents. Nano ne dessine plus
 * un textarea sous un curseur superposé : le moteur rend les cellules (`nano-edit`) et la
 * molette lui demande de défiler (`scrollView`), donc la première rangée change et la
 * cellule du curseur reste sur le texte qui lui appartient.
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

test.describe('Scénario (e2e) — la fenêtre nano suit la molette', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('un défilement molette fait défiler la fenêtre de trois lignes', async ({ page }) => {
    await typeCmd(page, 'for i in $(seq 1 80); do echo "line $i" >> /tmp/scroll.txt; done');
    await typeCmd(page, 'nano /tmp/scroll.txt');
    const body = page.locator('[data-testid="nano-body"]');
    await expect(body).toBeVisible({ timeout: 5_000 });
    expect((await nanoRows(page))[0]).toBe('line 1');

    await body.hover();
    await page.mouse.wheel(0, 120);
    await expect.poll(async () => (await nanoRows(page))[0]).toBe('line 4');
    const cursor = await nanoCursor(page);
    expect(cursor.row).toBeGreaterThanOrEqual(1);
  });

  test('la gouttière de numéros de ligne suit aussi le défilement', async ({ page }) => {
    await typeCmd(page, 'for i in $(seq 1 80); do echo "line $i" >> /tmp/scroll2.txt; done');
    await typeCmd(page, 'nano -l /tmp/scroll2.txt');
    const body = page.locator('[data-testid="nano-body"]');
    await expect(body).toBeVisible({ timeout: 5_000 });
    expect((await nanoRows(page))[0]).toBe(' 1 line 1');

    await body.hover();
    await page.mouse.wheel(0, 120);
    await expect.poll(async () => (await nanoRows(page))[0]).toBe(' 4 line 4');
  });
});

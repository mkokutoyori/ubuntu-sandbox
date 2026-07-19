import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 14 (e2e) — Undo/redo nano (Alt+U / Alt+E), pilotée depuis la
 * vraie UI terminal : une frappe continue s'annule en un seul geste,
 * puis se rétablit, vérifié en sauvegardant puis relisant le fichier
 * réel.
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
function lastCommandOutput(transcript: string, command: string): string {
  return transcript.slice(transcript.lastIndexOf(command));
}
async function typeText(page: Page, text: string): Promise<void> {
  for (const ch of text) {
    await page.evaluate((c) => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: c, bubbles: true, cancelable: true }));
    }, ch);
  }
}

test.describe('Scénario 14 (e2e) — undo/redo nano', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test("Alt+U annule une frappe continue en un seul geste, Alt+E la rétablit, et l'écriture finale sur disque est correcte", async ({ page }) => {
    await typeCmd(page, "printf 'base\\n' > /tmp/nano-undo-e2e.txt");
    await typeCmd(page, 'nano /tmp/nano-undo-e2e.txt');
    await expect(page.locator('[data-testid="nano-titlebar"]')).toContainText('nano-undo-e2e.txt', { timeout: 5_000 });

    await page.keyboard.press('End');
    await typeText(page, 'XYZ');
    await expect(page.getByText('baseXYZ', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Alt+u');
    await expect(page.getByText('baseXYZ')).not.toBeVisible();
    await expect(page.getByText('base', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Alt+e');
    await expect(page.getByText('baseXYZ', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Control+o');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+x');
    await expect(page.locator('[data-testid="nano-titlebar"]')).not.toBeVisible({ timeout: 5_000 });

    await typeCmd(page, 'cat /tmp/nano-undo-e2e.txt');
    const out = lastCommandOutput(await modalText(page), 'cat /tmp/nano-undo-e2e.txt');
    expect(out).toContain('baseXYZ');
  });
});

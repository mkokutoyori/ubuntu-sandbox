import { test, expect, type Page } from '@playwright/test';
import { nanoText } from './helpers/nanoScreen';

/**
 * Scénario (e2e) — coller depuis le presse-papiers du navigateur dans
 * nano, et cliquer dans le texte pour repositionner le curseur. Jusqu'ici
 * aucun des deux ne passait par le moteur : coller une config multi-
 * lignes était impossible (aucun `onPaste`), et un clic déplaçait le
 * curseur natif du textarea sans jamais informer NanoEngine — la frappe
 * suivante s'insérait donc à l'ancienne position puis "sautait".
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
/** Dispatch a genuine browser `paste` DOM event on the focused element —
 *  avoids OS clipboard-permission flakiness while still exercising the
 *  real onPaste handler wiring end to end. */
async function pasteText(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const el = document.activeElement as HTMLElement;
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

test.describe('Scénario (e2e) — coller et cliquer dans nano', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('coller un bloc multi-lignes (resolv.conf) insère chaque ligne, comme si tapé', async ({ page }) => {
    await typeCmd(page, 'nano /etc/resolv.conf');
    await expect(page.locator('[data-testid="nano-body"]')).toBeVisible({ timeout: 5_000 });

    await pasteText(page, 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n');

    await expect.poll(() => nanoText(page)).toMatch(/nameserver 8\.8\.8\.8/);
    await expect.poll(() => nanoText(page)).toMatch(/nameserver 1\.1\.1\.1/);

    const titlebar = page.locator('[data-testid="nano-titlebar"]');
    await expect(titlebar).toContainText('Modified');
  });

  test('le collage entier s\'annule en un seul Alt+U', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/paste-undo.txt');
    await expect(page.locator('[data-testid="nano-body"]')).toBeVisible({ timeout: 5_000 });

    await pasteText(page, 'line1\nline2\nline3');
    await expect.poll(() => nanoText(page)).toMatch(/line3/);

    await page.keyboard.press('Alt+u');
    await expect.poll(() => nanoText(page)).not.toMatch(/line1/);
  });

  test('cliquer dans le texte repositionne le curseur : la frappe suivante s\'insère au point cliqué', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/click-test.txt');
    await expect(page.locator('[data-testid="nano-body"]')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('helloworld');

    const body = await page.locator('[data-testid="nano-body"]').boundingBox();
    const caret = await page.locator('[data-testid="nano-cursor"]').boundingBox();
    expect(body).not.toBeNull();
    expect(caret).not.toBeNull();
    const cell = caret!.width;
    await page.mouse.click(body!.x + 5.5 * cell, body!.y + 1.5 * caret!.height);
    await page.keyboard.type('-BIG-');

    await expect.poll(() => nanoText(page)).toBe('hello-BIG-world');
  });
});

import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 10 (e2e) — Récupération de fichiers corrompus via vim,
 * pilotée depuis la vraie UI terminal : nettoyage CRLF/CR isolé, et
 * suppression d'un octet NUL via l'édition du dump `:%!xxd` / `:%!xxd -r`.
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
async function exCmd(page: Page, cmd: string): Promise<void> {
  await page.keyboard.press(':');
  await typeText(page, cmd);
  await page.keyboard.press('Enter');
}
function lastCommandOutput(transcript: string, command: string): string {
  return transcript.slice(transcript.lastIndexOf(command));
}

test.describe('Scénario 10 (e2e) — récupération de fichiers corrompus', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('vim finds and strips a stray embedded CR (\\r), fixed file has consistent CRLF', async ({ page }) => {
    await typeCmd(page, "printf 'line1\\r\\nline2\\rline2b\\r\\nline3\\n' > /tmp/crlf-e2e.txt");
    await typeCmd(page, 'vim /tmp/crlf-e2e.txt');
    await expect(page.getByText('crlf-e2e.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await exCmd(page, 'set fileformat?');
    await expect(page.getByText('fileformat=dos')).toBeVisible({ timeout: 5_000 });

    await exCmd(page, '%s/\\r//g');
    await exCmd(page, 'wq');

    await typeCmd(page, 'xxd /tmp/crlf-e2e.txt');
    const transcript = await modalText(page);
    const out = lastCommandOutput(transcript, 'xxd /tmp/crlf-e2e.txt');
    // "line2line2b" (the merge point) with a clean 0d0a pair right after it —
    // no stray, unpaired 0d anywhere in that run.
    expect(out).not.toMatch(/6c696e6532 ?6c696e6532620d(?!0a)/);
    expect(out).toContain('0d0a');
  });

  test('vim removes an embedded NUL byte via :%!xxd editing, then :%!xxd -r restores clean binary', async ({ page }) => {
    await typeCmd(page, "printf 'ID:001\\x00ID:002\\n' > /tmp/nul-e2e.bin");
    await typeCmd(page, 'vim /tmp/nul-e2e.bin');
    await expect(page.getByText('nul-e2e.bin', { exact: true })).toBeVisible({ timeout: 5_000 });

    await exCmd(page, '%!xxd');
    await expect(page.getByText('0049', { exact: false })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('/');
    await typeText(page, '0049');
    await page.keyboard.press('Enter');
    await page.keyboard.press('x');
    await page.keyboard.press('x');

    await exCmd(page, '%!xxd -r');
    await exCmd(page, 'wq');

    await typeCmd(page, 'cat /tmp/nul-e2e.bin');
    const transcript = await modalText(page);
    const out = lastCommandOutput(transcript, 'cat /tmp/nul-e2e.bin');
    expect(out).toContain('ID:001ID:002');
  });
});

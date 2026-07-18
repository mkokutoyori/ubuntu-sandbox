import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 3 (e2e) — Recherche (Ctrl+W) et remplacement (Ctrl+\) dans
 * nano, pilotés depuis la vraie UI terminal.
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

test.describe('Scénario 3 (e2e) — nano Ctrl+W / Ctrl+\\', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('Ctrl+W finds text; Ctrl+\\ replace with A applies to every occurrence', async ({ page }) => {
    await typeCmd(page, 'echo "eth0 up" > /tmp/nano-replace.txt');
    await typeCmd(page, 'echo "eth1 up" >> /tmp/nano-replace.txt');
    await typeCmd(page, 'nano /tmp/nano-replace.txt');
    await expect(page.getByText('GNU nano')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Control+w');
    await expect(page.getByText('Search:')).toBeVisible();
    await typeText(page, 'eth1');
    await page.keyboard.press('Enter');

    await page.keyboard.press('Control+\\');
    await expect(page.getByText('Search (to replace):')).toBeVisible();
    // Real nano prefills the last search term ("eth1") with the cursor at
    // the end — a real user backspaces it away before typing a new term.
    for (let i = 0; i < 10; i++) await page.keyboard.press('Backspace');
    await typeText(page, 'eth');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Replace with:')).toBeVisible();
    await typeText(page, 'ens');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Replace this instance?')).toBeVisible();
    await page.keyboard.press('a');

    await page.keyboard.press('Control+x');
    await expect(page.getByText('Save modified buffer?')).toBeVisible();
    await page.keyboard.press('y');
    await typeCmd(page, 'cat /tmp/nano-replace.txt');
    const transcript = await modalText(page);
    const catOutput = transcript.slice(transcript.lastIndexOf('cat /tmp/nano-replace.txt'));
    expect(catOutput).toContain('ens0 up');
    expect(catOutput).toContain('ens1 up');
  });

  test('regex replace with an empty string blanks matching lines instead of removing them', async ({ page }) => {
    await typeCmd(page, 'echo "keep" > /tmp/nano-regex.txt');
    await typeCmd(page, 'echo "#comment" >> /tmp/nano-regex.txt');
    await typeCmd(page, 'nano /tmp/nano-regex.txt');
    await expect(page.getByText('GNU nano')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Control+\\');
    await page.keyboard.press('Alt+r');
    await expect(page.getByText('[Regexp]')).toBeVisible();
    await typeText(page, '^#.*');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // empty replacement
    await page.keyboard.press('a');

    await page.keyboard.press('Control+x');
    await expect(page.getByText('Save modified buffer?')).toBeVisible();
    await page.keyboard.press('y');
    await typeCmd(page, 'wc -l < /tmp/nano-regex.txt');
    const transcript = await modalText(page);
    const wcOutput = transcript.slice(transcript.lastIndexOf('wc -l < /tmp/nano-regex.txt'));
    expect(wcOutput).toContain('\n2\n'); // still 2 lines, not 1 — nano blanked the line, vim would have removed it
  });
});

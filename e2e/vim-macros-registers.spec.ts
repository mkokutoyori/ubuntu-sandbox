import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 5 (e2e) — Macros vim (qa...q, N@a) et registres nommés
 * ("ayy/"ap), pilotés depuis la vraie UI terminal.
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
async function seedFile(page: Page, path: string, lines: string[]): Promise<void> {
  await typeCmd(page, `echo "${lines[0]}" > ${path}`);
  for (const line of lines.slice(1)) await typeCmd(page, `echo "${line}" >> ${path}`);
}

test.describe('Scénario 5 (e2e) — macros et registres vim', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('qa...q records a macro, N@a replays it on the remaining lines', async ({ page }) => {
    await seedFile(page, '/tmp/macro.txt', [
      'host server1 status old',
      'host server2 status old',
      'host server3 status old',
    ]);
    await typeCmd(page, 'vim /tmp/macro.txt');
    await expect(page.getByText('macro.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('q'); await page.keyboard.press('a');
    await expect(page.getByText('recording @a')).toBeVisible();
    await page.keyboard.press('0');
    await page.keyboard.press('w'); await page.keyboard.press('w'); await page.keyboard.press('w');
    await page.keyboard.press('c'); await page.keyboard.press('w');
    await typeText(page, 'new');
    await page.keyboard.press('Escape');
    await page.keyboard.press('j');
    await page.keyboard.press('0');
    await page.keyboard.press('q');
    await expect(page.getByText('recording @a')).not.toBeVisible();

    await page.keyboard.press('2'); await page.keyboard.press('@'); await page.keyboard.press('a');

    await exCmd(page, 'wq');
    await typeCmd(page, 'cat /tmp/macro.txt');
    const transcript = await modalText(page);
    const catOutput = transcript.slice(transcript.lastIndexOf('cat /tmp/macro.txt'));
    expect(catOutput).toContain('host server1 status new');
    expect(catOutput).toContain('host server2 status new');
    expect(catOutput).toContain('host server3 status new');
  });

  test('"ayy / "byy / "ap / "bp keep independent named registers', async ({ page }) => {
    await seedFile(page, '/tmp/registers.txt', ['line-a', 'line-b', 'line-c']);
    await typeCmd(page, 'vim /tmp/registers.txt');
    await expect(page.getByText('registers.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('"'); await page.keyboard.press('a'); await page.keyboard.press('y'); await page.keyboard.press('y');
    await page.keyboard.press('j');
    await page.keyboard.press('"'); await page.keyboard.press('b'); await page.keyboard.press('y'); await page.keyboard.press('y');
    await page.keyboard.press('G');
    await page.keyboard.press('"'); await page.keyboard.press('a'); await page.keyboard.press('p');
    await page.keyboard.press('"'); await page.keyboard.press('b'); await page.keyboard.press('p');

    await exCmd(page, 'wq');
    await typeCmd(page, 'cat /tmp/registers.txt');
    const transcript = await modalText(page);
    const catOutput = transcript.slice(transcript.lastIndexOf('cat /tmp/registers.txt'));
    const lines = catOutput.split('\n').filter((l) => l.startsWith('line-'));
    expect(lines).toEqual(['line-a', 'line-b', 'line-c', 'line-a', 'line-b']);
  });
});

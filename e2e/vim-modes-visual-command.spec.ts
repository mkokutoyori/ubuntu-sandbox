import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 4 (e2e) — Modes vim avancés (NORMAL/INSERT/VISUAL/VISUAL
 * LINE/VISUAL BLOCK/COMMAND-LINE), pilotés depuis la vraie UI terminal.
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

test.describe('Scénario 4 (e2e) — modes vim avancés', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('NORMAL: dd, u, Ctrl+r round-trip through the real UI', async ({ page }) => {
    await seedFile(page, '/tmp/normal.txt', ['one', 'two', 'three']);
    await typeCmd(page, 'vim /tmp/normal.txt');
    await expect(page.getByText('normal.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('d'); await page.keyboard.press('d');
    await page.keyboard.press('u');
    await page.keyboard.press('Control+r');

    await exCmd(page, 'wq');
    await typeCmd(page, 'cat /tmp/normal.txt');
    const transcript = await modalText(page);
    const catOutput = transcript.slice(transcript.lastIndexOf('cat /tmp/normal.txt'));
    expect(catOutput).toContain('two');
    expect(catOutput).toContain('three');
    expect(catOutput).not.toMatch(/\none\n/);
  });

  test('VISUAL: v-select-delete removes exactly the selection', async ({ page }) => {
    await seedFile(page, '/tmp/visual.txt', ['hello world']);
    await typeCmd(page, 'vim /tmp/visual.txt');
    await expect(page.getByText('visual.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('v');
    await expect(page.getByText('-- VISUAL --')).toBeVisible();
    for (let i = 0; i < 4; i++) await page.keyboard.press('l');
    await page.keyboard.press('d');
    await expect(page.getByText('-- VISUAL --')).not.toBeVisible();

    await exCmd(page, 'wq');
    await typeCmd(page, 'cat /tmp/visual.txt');
    const transcript = await modalText(page);
    expect(transcript.slice(transcript.lastIndexOf('cat /tmp/visual.txt'))).toContain(' world');
  });

  test('VISUAL LINE: V-select-indent prefixes selected lines with spaces', async ({ page }) => {
    await seedFile(page, '/tmp/vline.txt', ['a', 'b', 'c']);
    await typeCmd(page, 'vim /tmp/vline.txt');
    await expect(page.getByText('vline.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('V');
    await expect(page.getByText('-- VISUAL LINE --')).toBeVisible();
    await page.keyboard.press('j');
    await page.keyboard.press('>');

    await exCmd(page, 'wq');
    await typeCmd(page, 'cat /tmp/vline.txt');
    const transcript = await modalText(page);
    const catOutput = transcript.slice(transcript.lastIndexOf('cat /tmp/vline.txt'));
    expect(catOutput).toContain('    a');
    expect(catOutput).toContain('    b');
  });

  test('VISUAL BLOCK: Ctrl+v, select rows, I, type, Esc prefixes every row at the same column', async ({ page }) => {
    await seedFile(page, '/tmp/vblock.txt', ['host1', 'host2', 'host3']);
    await typeCmd(page, 'vim /tmp/vblock.txt');
    await expect(page.getByText('vblock.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Control+v');
    await expect(page.getByText('-- VISUAL BLOCK --')).toBeVisible();
    await page.keyboard.press('j'); await page.keyboard.press('j');
    await page.keyboard.press('I');
    await expect(page.getByText('-- INSERT --')).toBeVisible();
    await typeText(page, '#');
    await page.keyboard.press('Escape');

    await exCmd(page, 'wq');
    await typeCmd(page, 'cat /tmp/vblock.txt');
    const transcript = await modalText(page);
    const catOutput = transcript.slice(transcript.lastIndexOf('cat /tmp/vblock.txt'));
    expect(catOutput).toContain('#host1');
    expect(catOutput).toContain('#host2');
    expect(catOutput).toContain('#host3');
  });

  test('COMMAND-LINE: :%!sort filters the whole buffer through an external command', async ({ page }) => {
    await seedFile(page, '/tmp/cmdline.txt', ['banana', 'apple', 'cherry']);
    await typeCmd(page, 'vim /tmp/cmdline.txt');
    await expect(page.getByText('cmdline.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await exCmd(page, '%!sort');
    await exCmd(page, 'wq');

    await typeCmd(page, 'cat /tmp/cmdline.txt');
    const transcript = await modalText(page);
    const catOutput = transcript.slice(transcript.lastIndexOf('cat /tmp/cmdline.txt'));
    expect(catOutput).toContain('apple');
    expect(catOutput.indexOf('apple')).toBeLessThan(catOutput.indexOf('banana'));
    expect(catOutput.indexOf('banana')).toBeLessThan(catOutput.indexOf('cherry'));
  });
});

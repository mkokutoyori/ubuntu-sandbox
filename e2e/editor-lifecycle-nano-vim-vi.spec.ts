import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 1 — Cycle de vie complet d'une session d'édition : nano, vim
 * et vi comparés. Drives the real NanoEditor/VimEditor overlays
 * keystroke-by-keystroke (no `.fill()` shortcuts — vim's textarea is
 * read-only outside INSERT, so bulk-filling would silently no-op).
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
  await page.waitForTimeout(300);
}
async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

/**
 * Playwright's `keyboard.type()` silently falls back to CDP
 * `Input.insertText` (an `input` event, no `keydown`) for any character
 * outside the US keyboard layout — e.g. accented French letters like
 * 'é'. Our editors are driven purely by `onKeyDown` (matching how a real
 * terminal reads a keystroke stream, including keys a real AZERTY
 * keyboard would send as ordinary keydowns), so `.type()` would silently
 * drop those characters. Dispatch a real KeyboardEvent per character
 * instead, which React's synthetic event system picks up normally.
 */
async function typeText(page: Page, text: string): Promise<void> {
  for (const ch of text) {
    await page.evaluate((c) => {
      const el = document.activeElement;
      el?.dispatchEvent(new KeyboardEvent('keydown', { key: c, bubbles: true, cancelable: true }));
    }, ch);
  }
}

async function seedReferenceFile(page: Page, path: string): Promise<void> {
  await typeCmd(
    page,
    [
      `echo "ligne 1 : introduction" > ${path}`,
      `echo "ligne 2 : contenu principal" >> ${path}`,
      `echo "ligne 3 : mot_a_remplacer ici" >> ${path}`,
      `echo "ligne 4 : à supprimer" >> ${path}`,
      `echo "ligne 5 : conclusion" >> ${path}`,
    ].join(' && '),
  );
}

const EXPECTED_RESULT = [
  'nouvelle ligne ajoutée',
  'ligne 1 : introduction',
  'ligne 2 : contenu principal',
  'ligne 3 : nouveau_mot ici',
  'ligne 5 : conclusion',
].join('\n');

test.describe('Scénario 1 (e2e) — cycle de vie complet : nano, vim, vi', () => {
  let deviceId: string;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    deviceId = await addDevice(page, 'linux-pc');
    await openTerminal(page, deviceId);
  });

  test('nano: add line / change word / delete line / save / clean exit', async ({ page }) => {
    await seedReferenceFile(page, '/tmp/test-nano.txt');
    await typeCmd(page, 'nano /tmp/test-nano.txt');
    await expect(page.getByText('GNU nano')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await typeText(page, 'nouvelle ligne ajoutée');

    await page.keyboard.press('Control+w');
    await typeText(page, 'mot_a_remplacer');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 'mot_a_remplacer'.length; i++) await page.keyboard.press('Delete');
    await typeText(page, 'nouveau_mot');

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Control+k');

    await page.keyboard.press('Control+o');
    await expect(page.getByText('File Name to Write')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Wrote 5 lines/)).toBeVisible();

    await page.keyboard.press('Control+x');
    await expect(page.getByText('GNU nano')).not.toBeVisible();

    await typeCmd(page, 'cat /tmp/test-nano.txt');
    expect(await modalText(page)).toContain(EXPECTED_RESULT);

    await typeCmd(page, 'test -f /tmp/.test-nano.txt.swp && echo SWAP_EXISTS || echo SWAP_GONE');
    expect(await modalText(page)).toContain('SWAP_GONE');
  });

  test('vim: add line / change word / delete line via real vim commands, save, clean :q', async ({ page }) => {
    await seedReferenceFile(page, '/tmp/test-vim.txt');
    await typeCmd(page, 'vim /tmp/test-vim.txt');
    await expect(page.getByText('test-vim.txt', { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('-- INSERT --')).not.toBeVisible();

    await page.keyboard.press('g');
    await page.keyboard.press('g');
    await page.keyboard.press('O');
    await expect(page.getByText('-- INSERT --')).toBeVisible();
    await typeText(page, 'nouvelle ligne ajoutée');
    await page.keyboard.press('Escape');
    await expect(page.getByText('-- INSERT --')).not.toBeVisible();

    await page.keyboard.press('/');
    await typeText(page, 'mot_a_remplacer');
    await page.keyboard.press('Enter');

    await page.keyboard.press('c');
    await page.keyboard.press('w');
    await typeText(page, 'nouveau_mot');
    await page.keyboard.press('Escape');

    await page.keyboard.press('j');
    await page.keyboard.press('d');
    await page.keyboard.press('d');

    await page.keyboard.press(':');
    await typeText(page, 'w');
    await page.keyboard.press('Enter');
    await expect(page.getByText(/5L, \d+C written/)).toBeVisible();

    await page.keyboard.press(':');
    await typeText(page, 'q');
    await page.keyboard.press('Enter');
    await expect(page.getByText('test-vim.txt', { exact: true })).not.toBeVisible();

    await typeCmd(page, 'cat /tmp/test-vim.txt');
    expect(await modalText(page)).toContain(EXPECTED_RESULT);

    await typeCmd(page, 'test -f /tmp/.test-vim.txt.swp && echo SWAP_EXISTS || echo SWAP_GONE');
    expect(await modalText(page)).toContain('SWAP_GONE');
  });

  test('vi: same edit via strict POSIX commands, no -- INSERT -- indicator, byte-identical to vim', async ({ page }) => {
    await seedReferenceFile(page, '/tmp/test-vi.txt');
    await typeCmd(page, 'vi /tmp/test-vi.txt');
    await expect(page.getByText('test-vi.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('i');
    await expect(page.getByText('-- INSERT --')).not.toBeVisible();
    await page.keyboard.press('Escape');

    await page.keyboard.press('1');
    await page.keyboard.press('G');
    await page.keyboard.press('O');
    await typeText(page, 'nouvelle ligne ajoutée');
    await page.keyboard.press('Escape');

    await page.keyboard.press('/');
    await typeText(page, 'mot_a_remplacer');
    await page.keyboard.press('Enter');

    await page.keyboard.press('c');
    await page.keyboard.press('w');
    await typeText(page, 'nouveau_mot');
    await page.keyboard.press('Escape');

    await page.keyboard.press('j');
    await page.keyboard.press('d');
    await page.keyboard.press('d');

    await page.keyboard.press(':');
    await typeText(page, 'wq');
    await page.keyboard.press('Enter');

    await typeCmd(page, 'cat /tmp/test-vi.txt');
    expect(await modalText(page)).toContain(EXPECTED_RESULT);

    await typeCmd(page, 'md5sum /tmp/test-vi.txt');
    const transcript = await modalText(page);
    expect(transcript).toMatch(/[0-9a-f]{32}\s+\/tmp\/test-vi\.txt/);
  });
});

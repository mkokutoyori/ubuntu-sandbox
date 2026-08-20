import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 12 (e2e) — Objets de texte vim (`diw`, `daw`, `ci"`, `di(`,
 * `diB`), pilotés depuis la vraie UI terminal, vérifiés en sauvegardant
 * puis relisant le fichier réel.
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
async function exCmd(page: Page, cmd: string): Promise<void> {
  await page.keyboard.press(':');
  await typeText(page, cmd);
  await page.keyboard.press('Enter');
}
async function moveToCol(page: Page, col: number): Promise<void> {
  await page.keyboard.press('0');
  for (let i = 0; i < col; i++) await page.keyboard.press('l');
}

test.describe('Scénario 12 (e2e) — objets de texte vim', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('daw supprime un mot et l\'espace qui suit, écrit correctement sur disque', async ({ page }) => {
    await typeCmd(page, "printf 'foo bar baz\\n' > /tmp/text-obj-word.txt");
    await typeCmd(page, 'vim /tmp/text-obj-word.txt');
    await expect(page.getByText('text-obj-word.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await moveToCol(page, 5); // inside "bar"
    await page.keyboard.press('d');
    await page.keyboard.press('a');
    await page.keyboard.press('w');
    await exCmd(page, 'wq');

    await typeCmd(page, 'cat /tmp/text-obj-word.txt');
    const out = lastCommandOutput(await modalText(page), 'cat /tmp/text-obj-word.txt');
    expect(out).toContain('foo baz');
    expect(out).not.toContain('bar');
  });

  test('ci" remplace le contenu entre guillemets, sauvegardé fidèlement', async ({ page }) => {
    await typeCmd(page, "printf 'msg=\"old value\" end\\n' > /tmp/text-obj-quote.txt");
    await typeCmd(page, 'vim /tmp/text-obj-quote.txt');
    await expect(page.getByText('text-obj-quote.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await moveToCol(page, 6); // inside "old value"
    await page.keyboard.press('c');
    await page.keyboard.press('i');
    await page.keyboard.press('"');
    await typeText(page, 'new value');
    await page.keyboard.press('Escape');
    await exCmd(page, 'wq');

    await typeCmd(page, 'cat /tmp/text-obj-quote.txt');
    const out = lastCommandOutput(await modalText(page), 'cat /tmp/text-obj-quote.txt');
    expect(out).toContain('msg="new value" end');
    expect(out).not.toContain('old value');
  });

  test('di( supprime le contenu entre parenthèses (paire la plus interne, imbriquée)', async ({ page }) => {
    await typeCmd(page, "printf 'outer(inner(deep), sibling)\\n' > /tmp/text-obj-paren.txt");
    await typeCmd(page, 'vim /tmp/text-obj-paren.txt');
    await expect(page.getByText('text-obj-paren.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await moveToCol(page, 13); // inside "deep"
    await page.keyboard.press('d');
    await page.keyboard.press('i');
    await page.keyboard.press('(');
    await exCmd(page, 'wq');

    await typeCmd(page, 'cat /tmp/text-obj-paren.txt');
    const out = lastCommandOutput(await modalText(page), 'cat /tmp/text-obj-paren.txt');
    expect(out).toContain('outer(inner(), sibling)');
  });
});

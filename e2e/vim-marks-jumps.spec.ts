import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 11 (e2e) — Marques et navigation par sauts dans vim, pilotée
 * depuis la vraie UI terminal : `m{a-z}` pose une marque, `` `{marque} ``
 * y saute exactement, `` `` `` revient sur ses pas, et une marque utilisée
 * comme mouvement d'opérateur (`d'a`) supprime réellement les bonnes
 * lignes du fichier une fois sauvegardé.
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

test.describe('Scénario 11 (e2e) — marques et sauts vim', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test("m{lettre} pose une marque, `{lettre} y saute, et d'{lettre} supprime les bonnes lignes une fois sauvegardé", async ({ page }) => {
    await typeCmd(page, "printf 'alpha\\nbeta\\ngamma\\ndelta\\nepsilon\\n' > /tmp/marks-e2e.txt");
    await typeCmd(page, 'vim /tmp/marks-e2e.txt');
    await expect(page.getByText('marks-e2e.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    // Mark line "beta" (line 2) as 'a'.
    await page.keyboard.press('j');
    await page.keyboard.press('m');
    await page.keyboard.press('a');

    // Jump to the end of the buffer, then delete from there back to the
    // mark ("beta" through "epsilon" inclusive) with d'a.
    await page.keyboard.press('G');
    await page.keyboard.press('d');
    await page.keyboard.press("'");
    await page.keyboard.press('a');

    await exCmd(page, 'wq');

    await typeCmd(page, 'cat /tmp/marks-e2e.txt');
    const transcript = await modalText(page);
    const out = lastCommandOutput(transcript, 'cat /tmp/marks-e2e.txt');
    expect(out).toContain('alpha');
    expect(out).not.toContain('beta');
    expect(out).not.toContain('gamma');
    expect(out).not.toContain('epsilon');
  });

  test('`` revient exactement à la position précédant le dernier saut par marque', async ({ page }) => {
    await typeCmd(page, "printf 'one\\ntwo\\nthree\\nfour\\n' > /tmp/backjump-e2e.txt");
    await typeCmd(page, 'vim /tmp/backjump-e2e.txt');
    await expect(page.getByText('backjump-e2e.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    // Mark "one" (line 1) as 'z', jump to the end, jump to the mark, then
    // jump straight back -- landing on "four" again, where dd removes it.
    await page.keyboard.press('m');
    await page.keyboard.press('z');
    await page.keyboard.press('G');
    await page.keyboard.press('`');
    await page.keyboard.press('z');
    await page.keyboard.press('`');
    await page.keyboard.press('`');
    await page.keyboard.press('d');
    await page.keyboard.press('d');

    await exCmd(page, 'wq');

    await typeCmd(page, 'cat /tmp/backjump-e2e.txt');
    const transcript = await modalText(page);
    const out = lastCommandOutput(transcript, 'cat /tmp/backjump-e2e.txt');
    expect(out).toContain('one');
    expect(out).toContain('two');
    expect(out).toContain('three');
    expect(out).not.toContain('four');
  });

  test('sauter sur une marque non posée affiche E20: Mark not set', async ({ page }) => {
    await typeCmd(page, "printf 'only line\\n' > /tmp/e20-e2e.txt");
    await typeCmd(page, 'vim /tmp/e20-e2e.txt');
    await expect(page.getByText('e20-e2e.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('`');
    await page.keyboard.press('q');
    await expect(page.getByText('E20: Mark not set')).toBeVisible({ timeout: 5_000 });
  });
});

import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 13 (e2e) — Auto-indentation vim (`:set autoindent`), pilotée
 * depuis la vraie UI terminal : Entrée en mode INSERT et `o` recopient
 * l'indentation, vérifié en sauvegardant puis relisant le fichier réel.
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

test.describe('Scénario 13 (e2e) — auto-indentation vim', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test(':set autoindent fait hériter la nouvelle ligne (Entrée) de l\'indentation, écrite fidèlement sur disque', async ({ page }) => {
    await typeCmd(page, "printf '    indented\\n' > /tmp/ai-e2e.txt");
    await typeCmd(page, 'vim /tmp/ai-e2e.txt');
    await expect(page.getByText('ai-e2e.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await exCmd(page, 'set autoindent');
    await page.keyboard.press('A');
    await page.keyboard.press('Enter');
    await typeText(page, 'second');
    await page.keyboard.press('Escape');
    await exCmd(page, 'wq');

    await typeCmd(page, 'cat /tmp/ai-e2e.txt');
    const out = lastCommandOutput(await modalText(page), 'cat /tmp/ai-e2e.txt');
    expect(out).toContain('    indented');
    expect(out).toContain('    second');
  });

  test('sans autoindent, Entrée ne recopie aucune indentation', async ({ page }) => {
    await typeCmd(page, "printf '    indented\\n' > /tmp/noai-e2e.txt");
    await typeCmd(page, 'vim /tmp/noai-e2e.txt');
    await expect(page.getByText('noai-e2e.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('A');
    await page.keyboard.press('Enter');
    await typeText(page, 'flat');
    await page.keyboard.press('Escape');
    await exCmd(page, 'wq');

    await typeCmd(page, 'cat /tmp/noai-e2e.txt');
    const out = lastCommandOutput(await modalText(page), 'cat /tmp/noai-e2e.txt');
    expect(out).toContain('    indented');
    expect(out).toContain('\nflat');
    expect(out).not.toContain('    flat');
  });
});

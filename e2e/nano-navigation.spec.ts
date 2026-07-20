import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario (e2e) — navigation nano manquante : PageUp/PageDown (^V/^Y),
 * Go To Line (^_), et insertion de tabulation (Tab). Aucun des trois ne
 * fonctionnait auparavant : impossible de parcourir un long fichier
 * autrement que flèche par flèche, "^_ Go To Line" était un raccourci
 * mort affiché dans la barre du mode vue, et Tab n'insérait rien.
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
/** Build a long file with a generator loop so the setup command stays short. */
async function seedLongFile(page: Page, path: string, lineCount: number): Promise<void> {
  await typeCmd(page, `for i in $(seq 1 ${lineCount}); do echo "line $i" >> ${path}; done`);
}

test.describe('Scénario (e2e) — navigation nano : PageUp/Down, Go To Line, Tab', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('^_ Go To Line saute directement à la ligne demandée', async ({ page }) => {
    await seedLongFile(page, '/tmp/goto.txt', 100);
    await typeCmd(page, 'nano /tmp/goto.txt');
    const textarea = page.locator('[data-testid="nano-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Control+_');
    const status = page.locator('[data-testid="nano-status-message"]');
    await expect(status).toContainText('Enter line number');

    await page.keyboard.type('42');
    await page.keyboard.press('Enter');
    await page.keyboard.type('-HERE-');

    await expect(textarea).toHaveValue(/-HERE-line 42/);
  });

  test('^V (Next Page) avance le curseur dans un long fichier', async ({ page }) => {
    await seedLongFile(page, '/tmp/page.txt', 100);
    await typeCmd(page, 'nano /tmp/page.txt');
    const textarea = page.locator('[data-testid="nano-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Control+v');
    await page.keyboard.type('-MARK-');

    const value = await textarea.inputValue();
    expect(value).not.toContain('-MARK-line 1\n');
    expect(value).toMatch(/-MARK-line \d+/);
  });

  test('Tab insère une tabulation littérale visible dans le buffer', async ({ page }) => {
    await typeCmd(page, 'nano /tmp/tabtest.txt');
    const textarea = page.locator('[data-testid="nano-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 5_000 });

    await textarea.click();
    await page.keyboard.type('a');
    await page.keyboard.press('Tab');
    await page.keyboard.type('b');

    await expect(textarea).toHaveValue('a\tb');
  });
});

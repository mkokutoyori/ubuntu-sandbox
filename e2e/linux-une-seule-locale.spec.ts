import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addDevice(page: Page, type: string, x: number, y: number): Promise<string> {
  return page.evaluate(({ type, x, y }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(type, x, y).id;
  }, { type, x, y });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForTimeout(200);
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

test.describe('une machine a une locale, et toutes ses vues la disent', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('localectl, locale, $LANG et le fichier s accordent', async ({ page }) => {
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'localectl');
    const statut = await modalText(page);
    expect(statut).toContain('System Locale: LANG=en_US.UTF-8');
    expect(statut).toContain('X11 Layout: us');

    await typeCmd(page, 'clear');
    await typeCmd(page, 'echo $LANG');
    expect(await modalText(page)).toContain('en_US.UTF-8');

    await typeCmd(page, 'clear');
    await typeCmd(page, 'locale');
    expect(await modalText(page)).toContain('LC_CTYPE="en_US.UTF-8"');

    await closeTerminal(page);
  });

  test('set-locale change les quatre vues, et refuse ce qui n est pas installe', async ({ page }) => {
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'localectl set-locale LANG=fr_FR.UTF-8');
    expect(await modalText(page))
      .toContain('Locale fr_FR.UTF-8 not installed, refusing.');

    await typeCmd(page, 'clear');
    await typeCmd(page, 'localectl set-locale LANG=C.UTF-8');
    await typeCmd(page, 'cat /etc/default/locale');
    expect(await modalText(page)).toContain('LANG=C.UTF-8');

    await typeCmd(page, 'clear');
    await typeCmd(page, 'echo $LANG');
    expect(await modalText(page)).toContain('C.UTF-8');

    await closeTerminal(page);
  });
});

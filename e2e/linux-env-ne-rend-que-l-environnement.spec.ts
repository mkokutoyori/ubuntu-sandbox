import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 45_000 });
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
  await page.waitForTimeout(400);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

test.describe('env rend l environnement, pas la table du shell', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('les variables non exportees restent hors de env', async ({ page }) => {
    test.slow();
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'env | sort | head -12');
    const environnement = await modalText(page);
    expect(environnement).toContain('HOME=/home/user');
    expect(environnement).toContain('PATH=');
    expect(environnement).not.toMatch(/^EUID=/m);
    expect(environnement).not.toMatch(/^UID=/m);
    expect(environnement).not.toMatch(/^HOSTNAME=/m);
    expect(environnement).not.toMatch(/^0=/m);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'echo "uid=$UID host=$HOSTNAME"');
    expect(await modalText(page)).toMatch(/uid=1000 host=linux-pc/);

    await closeTerminal(page);
  });

  test('export decide de ce qui passe a la commande', async ({ page }) => {
    test.slow();
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'MAVAR=bonjour; env | grep -c MAVAR');
    expect(await modalText(page)).toMatch(/grep -c MAVAR\s*\n\s*0\b/);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'export MAVAR=bonjour; env | grep MAVAR');
    expect(await modalText(page)).toMatch(/^MAVAR=bonjour$/m);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'AUTRE=coucou env | grep AUTRE');
    expect(await modalText(page)).toMatch(/^AUTRE=coucou$/m);

    await closeTerminal(page);
  });
});

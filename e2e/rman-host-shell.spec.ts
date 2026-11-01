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

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(600);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

test.describe('RMAN et SQL*Plus : HOST sans commande', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('ouvre un shell, et exit revient au RMAN> de la même session', async ({ page }) => {
    test.slow();
    const server = await addDevice(page, 'linux-server', 340, 260);
    await openTerminal(page, server);

    await typeCmd(page, 'rman target /');
    expect(await modalText(page)).toContain('connected to target database');

    await typeCmd(page, 'host;');
    await typeCmd(page, 'echo dans-le-shell-hote');
    expect(await modalText(page)).toContain('dans-le-shell-hote');

    await typeCmd(page, 'exit');
    expect(await modalText(page)).toContain('host command complete');

    await typeCmd(page, 'show all;');
    expect(await modalText(page)).toContain('RMAN configuration parameters');

    await typeCmd(page, 'exit');
    await typeCmd(page, 'echo retour-au-bash');
    expect(await modalText(page)).toContain('retour-au-bash');
  });

  test('SQL*Plus : host ouvre un shell, exit revient à SQL> sans message', async ({ page }) => {
    test.slow();
    const server = await addDevice(page, 'linux-server', 340, 260);
    await openTerminal(page, server);

    await typeCmd(page, 'sqlplus / as sysdba');
    expect(await modalText(page)).toContain('Connected.');

    await typeCmd(page, 'host');
    await typeCmd(page, 'echo dans-le-shell-sqlplus');
    expect(await modalText(page)).toContain('dans-le-shell-sqlplus');

    await typeCmd(page, 'exit');
    await typeCmd(page, 'select 1 from dual;');
    expect(await modalText(page)).toMatch(/\n\s*1\s*\n/);
    expect(await modalText(page)).not.toContain('SP2-0738');
  });
});

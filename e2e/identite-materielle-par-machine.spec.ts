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

async function lire(page: Page, id: string, command: string): Promise<string> {
  await openTerminal(page, id);
  await typeCmd(page, 'clear');
  await typeCmd(page, command);
  const texte = await modalText(page);
  await closeTerminal(page);
  return texte;
}

test.describe('deux machines du canevas sont deux machines differentes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('leurs machine-id et leurs UUID de systeme de fichiers different', async ({ page }) => {
    const a = await addDevice(page, 'linux-pc', 300, 220);
    const b = await addDevice(page, 'linux-pc', 520, 220);

    const idA = /^[0-9a-f]{32}$/m.exec(await lire(page, a, 'cat /etc/machine-id'))?.[0] ?? '<A>';
    const idB = /^[0-9a-f]{32}$/m.exec(await lire(page, b, 'cat /etc/machine-id'))?.[0] ?? '<B>';

    expect(idA).toMatch(/^[0-9a-f]{32}$/);
    expect(idB).not.toBe(idA);

    const uuid = (s: string) => /^UUID=(\S+)\s+\/\s/m.exec(s)?.[1] ?? '<aucun>';
    const fsA = uuid(await lire(page, a, 'cat /etc/fstab'));
    const fsB = uuid(await lire(page, b, 'cat /etc/fstab'));

    expect(fsA).toMatch(/^[0-9a-f]{8}-/);
    expect(fsB).not.toBe(fsA);
  });

  test('deux postes Windows portent deux UUID SMBIOS', async ({ page }) => {
    const w1 = await addDevice(page, 'windows-pc', 300, 400);
    const w2 = await addDevice(page, 'windows-pc', 520, 400);

    const smbios = (s: string) =>
      /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/.exec(s)?.[0] ?? '<aucun>';

    const u1 = smbios(await lire(page, w1, 'wmic csproduct get uuid'));
    const u2 = smbios(await lire(page, w2, 'wmic csproduct get uuid'));

    expect(u1).not.toBe('<aucun>');
    expect(u2).not.toBe(u1);
  });

  test('wmic rend les colonnes demandees et refuse une propriete inconnue', async ({ page }) => {
    const w1 = await addDevice(page, 'windows-pc', 300, 400);

    const sortie = await lire(page, w1, 'wmic logicaldisk get caption,freespace,size');
    const entete = sortie.split('\n').find((l) => l.includes('Caption')) ?? '';
    expect(entete.trim().split(/\s+/)).toEqual(['Caption', 'FreeSpace', 'Size']);
    expect(sortie).toMatch(/C: +\d+ +\d+/);

    expect(await lire(page, w1, 'wmic logicaldisk get zorglub'))
      .toContain('Description = Invalid query');
  });
});

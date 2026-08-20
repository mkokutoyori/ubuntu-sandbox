import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addDevice(page: Page, type: string, x = 400, y = 300): Promise<string> {
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
  await page.waitForTimeout(250);
}

async function typePassword(page: Page, password: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]');
  await input.focus();
  await input.fill(password);
  await input.press('Enter');
  await page.waitForTimeout(250);
}

async function becomeRoot(page: Page): Promise<void> {
  await typeCmd(page, 'sudo su -');
  await typePassword(page, 'admin');
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 8_000): Promise<void> {
  await expect.poll(async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('Scénario 3 — /etc/hosts et /etc/hostname (UI réelle)', () => {
  test('une entrée /etc/hosts hijackée prime sur la résolution normale', async ({ page }) => {
    const pcId = await addDevice(page, 'linux-pc');
    await openTerminal(page, pcId);
    await becomeRoot(page);
    await typeCmd(page, "printf '10.0.0.99 serveur-legitime.domaine.local\\n' >> /etc/hosts");
    await typeCmd(page, 'getent hosts serveur-legitime.domaine.local');
    await waitForText(page, '10.0.0.99');
  });

  test('hostnamectl set-hostname propage immédiatement sans redémarrage', async ({ page }) => {
    const pcId = await addDevice(page, 'linux-pc');
    await openTerminal(page, pcId);
    await becomeRoot(page);
    await typeCmd(page, 'hostnamectl set-hostname pc-renomme');
    await typeCmd(page, 'hostname');
    await waitForText(page, 'pc-renomme');
    await typeCmd(page, 'uname -n');
    await waitForText(page, 'pc-renomme');
  });
});

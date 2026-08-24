import { test, expect, type Page } from '@playwright/test';
import { fortiConsoleLogin } from './fortiConsole';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function poserFortiGate(page: Page): Promise<string> {
  return page.evaluate(() => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const created = store.getState().addDevice('firewall-fortinet', 320, 240);
    const device = store.getState().deviceInstances.get(created.id) as Record<string, unknown>;
    (device.powerOn as (() => void) | undefined)?.call(device);
    return created.id;
  });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]')
    .waitFor({ state: 'visible', timeout: 10_000 });
  await fortiConsoleLogin(page);
  await page.waitForTimeout(1200);
}

function input(page: Page) {
  return page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
}

async function fillAndTab(page: Page, text: string): Promise<string> {
  const box = input(page);
  await box.click();
  await box.fill(text);
  await box.press('Tab');
  await page.waitForTimeout(250);
  return box.inputValue();
}

test.describe('FortiGate — la tabulation developpe la ligne', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('`conf sys glo` devient `config system global`', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    expect((await fillAndTab(page, 'conf sys glo')).trim())
      .toBe('config system global');
  });

  test('`g sy stat` devient `get system status`, et s\'execute', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    const box = input(page);
    expect((await fillAndTab(page, 'g sy stat')).trim()).toBe('get system status');

    await box.press('Enter');
    await expect.poll(
      async () => (await page.locator('[data-testid="terminal-modal"]').innerText())
        .includes('Serial-Number:'), { timeout: 10_000 }).toBe(true);
  });
});

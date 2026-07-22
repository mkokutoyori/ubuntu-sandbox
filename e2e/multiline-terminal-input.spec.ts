/**
 * Multi-line / comment terminal input through the real UI (audit P2 +
 * user request): Cisco `!` comment lines paste cleanly, and a bash
 * here-document / open quote drives the `>` continuation prompt.
 */
import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice(t, 400, 300).id;
  }, type);
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(500);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(200);
}

async function modalText(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/', { timeout: 60_000 });
  await waitForStore(page);
});

test.afterEach(async ({ page }) => {
  await page.keyboard.press('Escape').catch(() => {});
});

test.describe('Cisco `!` comment lines paste cleanly through the UI', () => {
  test('a config fragment with `!` separators does not error and applies', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, '!');
    await typeCmd(page, '! LAN interface');
    await typeCmd(page, 'hostname PASTED-UI');
    await typeCmd(page, '!');
    await typeCmd(page, 'end');
    await typeCmd(page, 'show running-config');
    const text = await modalText(page);
    expect(text).not.toContain('% Invalid');
    expect(text).toContain('hostname PASTED-UI');
  });
});

test.describe('bash continuation through the UI', () => {
  test('a here-document collects until its delimiter', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'cat <<EOF');
    await typeCmd(page, 'première ligne');
    await typeCmd(page, 'deuxième ligne');
    await typeCmd(page, 'EOF');
    const text = await modalText(page);
    expect(text).toContain('première ligne');
    expect(text).toContain('deuxième ligne');
  });
});

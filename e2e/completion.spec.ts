/**
 * Tab auto-completion across the real terminal modal, for every equipment
 * terminal that the unified CompletionController drives:
 *   - Cisco IOS: unique-prefix completion, silent no-op on ambiguity.
 *   - Huawei VRP: unique completion + cycling on ambiguous repeated Tab.
 *   - Linux bash: path/command completion.
 *   - SQL*Plus subshell: Tab is intercepted (no browser focus leak) and
 *     completes SQL keywords — the PRD's headline bug fix.
 */
import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 15_000 },
  );
}

async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice(t, 400, 260).id;
  }, type);
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(400);
}

function input(page: Page) {
  return page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
}

async function typeLine(page: Page, text: string): Promise<void> {
  const box = input(page);
  await box.click();
  await box.fill(text);
  await box.press('Enter');
  await page.waitForTimeout(200);
}

async function fillAndTab(page: Page, text: string): Promise<string> {
  const box = input(page);
  await box.click();
  await box.fill(text);
  await box.press('Tab');
  await page.waitForTimeout(200);
  return box.inputValue();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.afterEach(async ({ page }) => {
  await page.keyboard.press('Escape').catch(() => {});
});

test.describe('Tab completion — Cisco IOS', () => {
  test('unique prefix "sh" + Tab completes to "show "', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);
    expect(await fillAndTab(page, 'sh')).toBe('show ');
  });

  test('ambiguous "s" + Tab is a silent no-op (input unchanged)', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);
    expect(await fillAndTab(page, 's')).toBe('s');
  });
});

test.describe('Tab completion — Huawei VRP', () => {
  test('unique prefix completes with a trailing space', async ({ page }) => {
    const id = await addDevice(page, 'router-huawei');
    await openTerminal(page, id);
    expect(await fillAndTab(page, 'sys')).toBe('system-view ');
  });

  test('ambiguous repeated Tab cycles through candidates (real VRP)', async ({ page }) => {
    const id = await addDevice(page, 'router-huawei');
    await openTerminal(page, id);
    const box = input(page);
    await box.click();
    await box.fill('s');
    await box.press('Tab');
    await page.waitForTimeout(150);
    const first = await box.inputValue();
    await box.press('Tab');
    await page.waitForTimeout(150);
    const second = await box.inputValue();
    expect(first).not.toBe('s');
    expect(second).not.toBe(first);
    expect(second.toLowerCase().startsWith('s')).toBe(true);
  });
});

test.describe('Tab completion — Linux bash', () => {
  test('command prefix "ifconf" + Tab completes to "ifconfig "', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    expect(await fillAndTab(page, 'ifconf')).toBe('ifconfig ');
  });
});

test.describe('Ghost text — inline preview of a unique completion', () => {
  test('Cisco: typing "sh" renders the grey "ow" ghost; ArrowRight accepts it', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);
    const box = input(page);
    await box.click();
    await box.fill('sh');
    await page.waitForTimeout(150);
    const ghost = page.locator('[data-testid="ghost-suggestion"]');
    await expect(ghost).toBeVisible();
    await expect(ghost).toHaveText('ow');
    await box.press('ArrowRight');
    await page.waitForTimeout(150);
    expect(await box.inputValue()).toBe('show');
  });

  test('Cisco: ambiguous "s" shows no ghost', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);
    const box = input(page);
    await box.click();
    await box.fill('s');
    await page.waitForTimeout(150);
    await expect(page.locator('[data-testid="ghost-suggestion"]')).toHaveCount(0);
  });
});

test.describe('Tab completion — SQL*Plus subshell (PRD headline: no focus leak)', () => {
  test('Tab inside sqlplus completes a keyword AND keeps focus on the terminal input', async ({ page }) => {
    const id = await addDevice(page, 'linux-server');
    await openTerminal(page, id);
    await typeLine(page, 'sqlplus / as sysdba');
    await expect(
      page.locator('[data-testid="terminal-modal"]').getByText('Connected.', { exact: false }),
    ).toBeVisible({ timeout: 12_000 });

    const box = input(page);
    await box.click();
    await box.fill('SEL');
    await box.press('Tab');
    await page.waitForTimeout(200);

    // The keyword completed …
    expect(await box.inputValue()).toBe('SELECT');
    // … and focus never escaped the terminal input to browser tab-navigation.
    const stillFocused = await box.evaluate((el) => el === document.activeElement);
    expect(stillFocused).toBe(true);
  });
});

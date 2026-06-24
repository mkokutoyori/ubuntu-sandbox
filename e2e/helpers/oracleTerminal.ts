import { expect, type Page } from '@playwright/test';

export async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

export async function addLinuxServer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice('linux-server', 400, 300).id;
  });
}

export async function openTerminal(page: Page, deviceId: string): Promise<void> {
  await page.locator(`[data-device-id="${deviceId}"]`).first().dblclick({ timeout: 5_000 });
  await expect(page.locator('[data-testid="terminal-modal"]')).toBeVisible({ timeout: 8_000 });
}

export function termText(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}

export async function typeLine(page: Page, text: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(text);
  await input.press('Enter');
}

export async function sql(page: Page, statement: string): Promise<string> {
  const before = (await termText(page)).length;
  await typeLine(page, statement);
  await expect.poll(async () => (await termText(page)).length, { timeout: 8_000 })
    .toBeGreaterThan(before);
  await page.waitForTimeout(150);
  return (await termText(page)).slice(before);
}

export async function runBlock(page: Page, lines: string[]): Promise<string> {
  const before = (await termText(page)).length;
  for (const line of lines) {
    await typeLine(page, line);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(250);
  return (await termText(page)).slice(before);
}

export async function launchSqlplus(page: Page): Promise<void> {
  await typeLine(page, 'sqlplus / as sysdba');
  await expect(
    page.locator('[data-testid="terminal-modal"]').getByText('Connected.', { exact: false }),
  ).toBeVisible({ timeout: 10_000 });
}

export async function setupSqlplus(page: Page): Promise<string> {
  await page.goto('/');
  await waitForStore(page);
  const id = await addLinuxServer(page);
  await openTerminal(page, id);
  await launchSqlplus(page);
  return id;
}

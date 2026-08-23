import type { Page } from '@playwright/test';

export const FORTI_LAB_PASSWORD = 'Fortinet123';

const MODAL = '[data-testid="terminal-modal"]';

async function modalText(page: Page): Promise<string> {
  return page.locator(MODAL).innerText();
}

async function waitForNeedle(page: Page, needle: string, timeout = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if ((await modalText(page)).includes(needle)) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(150);
  }
}

async function submit(page: Page, selector: string, value: string): Promise<void> {
  const field = page.locator(`${MODAL} ${selector}`).last();
  await field.waitFor({ state: 'attached', timeout: 10_000 });
  await field.focus();
  if (value.length > 0) await field.fill(value);
  await field.press('Enter');
  await page.waitForTimeout(250);
}

export async function fortiConsoleLogin(
  page: Page, password = FORTI_LAB_PASSWORD,
): Promise<void> {
  if (!(await waitForNeedle(page, 'login: '))) return;

  await submit(page, 'input[type="text"]', 'admin');
  if (!(await waitForNeedle(page, 'Password: ', 5_000))) return;
  await submit(page, 'input[type="password"]', '');

  if (!(await waitForNeedle(page, 'forced to change your password', 5_000))) return;
  await submit(page, 'input[type="password"]', password);
  await submit(page, 'input[type="password"]', password);
  await waitForNeedle(page, 'Welcome !', 5_000);
}

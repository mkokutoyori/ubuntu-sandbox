/**
 * Shared helpers for the Oracle transaction E2E specs.
 *
 * Every spec drives the real browser UI: it drops a Linux server on the
 * canvas, opens its graphical terminal, and launches the in-browser SQL*Plus
 * REPL with `sqlplus / as sysdba`. SQL is then typed into the live terminal
 * input and the visible scrollback is read back for assertions.
 *
 * These specs deliberately assert *real Oracle* behaviour. Where the
 * simulator diverges, the test fails — and the failure is the signal that
 * pinpoints the gap to fix.
 */

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

/** Full visible scrollback text of the terminal (input element values excluded). */
export function termText(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}

/** Type a line into the active terminal input and submit it. */
export async function typeLine(page: Page, text: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(text);
  await input.press('Enter');
}

/**
 * Submit one SQL*Plus line and return ONLY the newly-appended terminal text.
 * The scrollback is append-only and the entered line is always echoed, so the
 * text strictly grows; we poll for growth then slice off the delta. Returning
 * just the delta keeps positive/negative assertions unambiguous when a phrase
 * (e.g. "Rollback complete.") recurs across steps.
 */
export async function sql(page: Page, statement: string): Promise<string> {
  const before = (await termText(page)).length;
  await typeLine(page, statement);
  await expect.poll(async () => (await termText(page)).length, { timeout: 8_000 })
    .toBeGreaterThan(before);
  await page.waitForTimeout(150);
  return (await termText(page)).slice(before);
}

/**
 * Submit a multi-line PL/SQL block (or any multi-line statement). Pass every
 * line including the trailing `/` that runs the buffer. Returns the delta text
 * produced across the whole block.
 */
export async function runBlock(page: Page, lines: string[]): Promise<string> {
  const before = (await termText(page)).length;
  for (const line of lines) {
    await typeLine(page, line);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(250);
  return (await termText(page)).slice(before);
}

/** Launch the SQL*Plus REPL as SYSDBA and wait for the "Connected." banner. */
export async function launchSqlplus(page: Page): Promise<void> {
  await typeLine(page, 'sqlplus / as sysdba');
  await expect(
    page.locator('[data-testid="terminal-modal"]').getByText('Connected.', { exact: false }),
  ).toBeVisible({ timeout: 10_000 });
}

/** goto → store ready → add a Linux server → open its terminal → enter SQL*Plus. */
export async function setupSqlplus(page: Page): Promise<string> {
  await page.goto('/');
  await waitForStore(page);
  const id = await addLinuxServer(page);
  await openTerminal(page, id);
  await launchSqlplus(page);
  return id;
}

import { expect, type Page } from '@playwright/test';

/**
 * Helpers partagés par les specs e2e des scénarios !/#/bannières/heredoc
 * (scénarios Cisco 1-4, 6-7 et Linux 5, 8). Même patron que les autres
 * specs du dépôt : store exposé sur window, double-clic pour ouvrir le
 * terminal, saisie ligne à ligne.
 */

export async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

export async function addDevice(page: Page, type: string, x = 400, y = 250): Promise<string> {
  return page.evaluate(([t, px, py]) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice(t as string, px as number, py as number).id;
  }, [type, x, y]);
}

export async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(400);
}

export async function typeCmd(page: Page, command: string, settleMs = 250): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(settleMs);
}

export async function modalText(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}

export async function waitForText(page: Page, needle: string | RegExp, timeout = 8_000): Promise<void> {
  await expect.poll(async () => {
    const t = await modalText(page);
    return typeof needle === 'string' ? t.includes(needle) : needle.test(t);
  }, { timeout }).toBe(true);
}

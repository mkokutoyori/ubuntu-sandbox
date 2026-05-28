/**
 * Regression test for Linux → SSH → Windows.
 *
 * User report: after `ssh carl@…` from a Linux PC into a Windows PC,
 * the prompt rendered as `carl@PC2:C:\Users\User$ ` (Linux bash format
 * with the wrong path) and `powershell` failed to switch to a PS frame.
 * Expected: prompt is `C:\Users\carl>` and typing `powershell` swaps
 * the prompt to `PS C:\Users\carl>`.
 */

import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

async function setupLinuxWindowsLan(page: Page): Promise<{ pc1Id: string; pc2Id: string }> {
  return page.evaluate(async () => {
    type StoreState = {
      addDevice(type: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, b: string, c: string, d: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const pc1 = store.getState().addDevice('linux-pc', 200, 200);
    const pc2 = store.getState().addDevice('windows-pc', 500, 200);
    const inst1 = store.getState().deviceInstances.get(pc1.id) as Record<string, unknown>;
    const inst2 = store.getState().deviceInstances.get(pc2.id) as Record<string, unknown>;
    const ports1 = (inst1.getPortNames as () => string[])();
    const ports2 = (inst2.getPortNames as () => string[])();
    const p1 = ports1.find((n) => n.startsWith('eth')) ?? ports1[0];
    const p2 = ports2.find((n) => n.startsWith('eth')) ?? ports2[0];
    const exec1 = inst1.executeCommand as ((c: string) => Promise<string> | string) | undefined;
    const exec2 = inst2.executeCommand as ((c: string) => Promise<string> | string) | undefined;
    if (exec1) await Promise.resolve(exec1.call(inst1, `sudo ip addr add 192.168.1.10/24 dev ${p1}`));
    if (exec2) await Promise.resolve(exec2.call(inst2, `netsh interface ip set address name="${p2}" static 192.168.1.20 255.255.255.0`));
    store.getState().addConnection(pc1.id, p1, pc2.id, p2, 'ethernet');
    return { pc1Id: pc1.id, pc2Id: pc2.id };
  });
}

async function openTerminal(page: Page, deviceId: string): Promise<void> {
  await page.locator(`[data-device-id="${deviceId}"]`).first().dblclick({ timeout: 5_000 });
  await expect(page.locator('[data-testid="terminal-modal"]')).toBeVisible({ timeout: 8_000 });
}

async function typeCommand(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
}

async function typePassword(page: Page, password: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]');
  await input.focus();
  await input.fill(password);
  await input.press('Enter');
}

/** Snapshot every visible line inside the terminal modal. */
async function dumpTerminal(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}

test.describe('Linux → SSH → Windows', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('cmd prompt is `C:\\Users\\carl>` after SSH login', async ({ page }) => {
    const { pc1Id } = await setupLinuxWindowsLan(page);
    await openTerminal(page, pc1Id);
    await typeCommand(page, 'ssh carl@192.168.1.20');
    await expect(page.locator('[data-testid="terminal-modal"]').getByText('password', { exact: false }))
      .toBeVisible({ timeout: 12_000 });
    await typePassword(page, 'carl');

    // Wait a bit for prompt to settle, then capture.
    await page.waitForTimeout(500);
    const dump = await dumpTerminal(page);

    // Should NOT see the Linux-format hybrid prompt.
    expect(dump).not.toMatch(/carl@.*:.*\$/);
    // SHOULD see the cmd prompt for carl.
    expect(dump).toMatch(/C:\\Users\\carl>/);
  });

  test('typing `powershell` switches to PS prompt', async ({ page }) => {
    const { pc1Id } = await setupLinuxWindowsLan(page);
    await openTerminal(page, pc1Id);
    await typeCommand(page, 'ssh carl@192.168.1.20');
    await expect(page.locator('[data-testid="terminal-modal"]').getByText('password', { exact: false }))
      .toBeVisible({ timeout: 12_000 });
    await typePassword(page, 'carl');
    await page.waitForTimeout(300);

    await typeCommand(page, 'powershell');
    await page.waitForTimeout(500);
    const dump = await dumpTerminal(page);

    expect(dump).toMatch(/PS C:\\Users\\carl>/);
    await page.locator('[data-testid="terminal-modal"]').screenshot({
      path: 'test-results/linux-ssh-windows-powershell.png',
    });
  });
});

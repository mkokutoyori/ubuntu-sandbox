/**
 * Regression test for Linux → SSH → Windows, via a Layer-2 switch.
 *
 * User reported the bug persists even after the previous fix. This
 * spec reproduces the exact sequence they typed (`ssh carl@…` then
 * `powershell` then `gmc` then `ls`) on a topology with a generic
 * switch between PC1 and the Windows host — the same shape as the
 * user's failing scenario — and captures full-modal screenshots at
 * each step so we can compare against what they see.
 */

import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

/** PC1 (linux) ─── switch ─── PC2 (windows). */
async function setupSwitchedLan(page: Page): Promise<{ pc1Id: string; pc2Id: string; swId: string }> {
  return page.evaluate(async () => {
    type StoreState = {
      addDevice(type: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, b: string, c: string, d: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const pc1 = store.getState().addDevice('linux-pc', 150, 300);
    const sw  = store.getState().addDevice('switch-generic', 400, 300);
    const pc2 = store.getState().addDevice('windows-pc', 650, 300);

    const i1 = store.getState().deviceInstances.get(pc1.id) as Record<string, unknown>;
    const iS = store.getState().deviceInstances.get(sw.id)  as Record<string, unknown>;
    const i2 = store.getState().deviceInstances.get(pc2.id) as Record<string, unknown>;

    const p1 = ((i1.getPortNames as () => string[])()).find((n) => n.startsWith('eth')) ?? 'eth0';
    const p2 = ((i2.getPortNames as () => string[])()).find((n) => n.startsWith('eth')) ?? 'eth0';
    const swPorts = (iS.getPortNames as () => string[])();
    const swA = swPorts[0]; const swB = swPorts[1];

    const exec1 = i1.executeCommand as ((c: string) => Promise<string> | string) | undefined;
    const exec2 = i2.executeCommand as ((c: string) => Promise<string> | string) | undefined;
    if (exec1) await Promise.resolve(exec1.call(i1, `sudo ip addr add 192.168.1.1/24 dev ${p1}`));
    if (exec2) await Promise.resolve(exec2.call(i2, `netsh interface ip set address name="${p2}" static 192.168.1.2 255.255.255.0`));

    store.getState().addConnection(pc1.id, p1, sw.id, swA, 'ethernet');
    store.getState().addConnection(sw.id, swB, pc2.id, p2, 'ethernet');
    return { pc1Id: pc1.id, pc2Id: pc2.id, swId: sw.id };
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

async function dumpTerminal(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}

async function snap(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="terminal-modal"]').screenshot({
    path: `test-results/${name}.png`,
  });
}

test.describe('Linux → switch → Windows: SSH + powershell handoff', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('reproduce user sequence: ssh carl, powershell, gmc, ls', async ({ page }) => {
    await setupSwitchedLan(page);
    const ids = await page.evaluate(() => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): { deviceInstances: Map<string, Record<string, unknown>> };
      };
      const out: string[] = [];
      for (const [k, v] of store.getState().deviceInstances) {
        out.push(`${k}:${(v as { constructor: { name: string } }).constructor.name}`);
      }
      return out;
    });
    console.log('topology:', ids);

    const pc1Id = await page.evaluate(() => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): { deviceInstances: Map<string, Record<string, unknown>> };
      };
      for (const [k, v] of store.getState().deviceInstances) {
        if ((v as { constructor: { name: string } }).constructor.name === 'LinuxPC') return k;
      }
      throw new Error('no LinuxPC');
    });

    await openTerminal(page, pc1Id);
    await snap(page, 'switched-01-opened');

    await typeCommand(page, 'ssh carl@192.168.1.2');
    await expect(page.locator('[data-testid="terminal-modal"]').getByText('password', { exact: false }))
      .toBeVisible({ timeout: 12_000 });
    await snap(page, 'switched-02-password-prompt');

    await typePassword(page, 'carl');
    await page.waitForTimeout(800);
    const afterLogin = await dumpTerminal(page);
    await snap(page, 'switched-03-after-login');
    console.log('--- after login ---\n' + afterLogin);

    // BUG GUARD: should NOT show the Linux-format hybrid prompt
    // (carl@PC2:C:\Users\User$).
    expect(afterLogin).not.toMatch(/carl@.+:.+\$/);
    expect(afterLogin).toMatch(/C:\\Users\\carl>/);

    await typeCommand(page, 'powershell');
    await page.waitForTimeout(800);
    const afterPs = await dumpTerminal(page);
    await snap(page, 'switched-04-after-powershell');
    console.log('--- after powershell ---\n' + afterPs);

    expect(afterPs).toMatch(/PS C:\\Users\\carl>/);

    await typeCommand(page, 'Get-Location');
    await page.waitForTimeout(400);
    await snap(page, 'switched-05-after-get-location');

    await typeCommand(page, 'ls');
    await page.waitForTimeout(400);
    const afterLs = await dumpTerminal(page);
    await snap(page, 'switched-06-after-ls');
    console.log('--- after ls ---\n' + afterLs);

    // PS understands `ls` as Get-ChildItem — it must NOT report
    // "is not recognized as an internal or external command".
    expect(afterLs).not.toMatch(/is not recognized as an internal or external command/);
  });
});

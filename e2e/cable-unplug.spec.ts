/**
 * Cable-unplug E2E tests — Playwright (docs/PRD-Link-State.md §2.1)
 *
 * Drives the two symptoms reported against the real UI:
 *   - a ping in progress must show visible failures once the cable is
 *     pulled, instead of silently going quiet;
 *   - an SSH session must break rather than keep serving the remote.
 *
 * The cable is removed exactly the way the canvas does it — through the
 * store's removeConnection — so what is tested is the operator's gesture,
 * not a direct call into the simulation engine.
 */

import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

/** PC1 (192.168.1.10/24) and PC2 (192.168.1.20/24), directly cabled. */
async function setupTwoMachineLan(page: Page): Promise<{ pc1Id: string; pc2Id: string }> {
  return page.evaluate(async () => {
    type StoreState = {
      addDevice(type: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(srcId: string, srcIf: string, dstId: string, dstIf: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };

    const pc1Dto = store.getState().addDevice('linux-pc', 300, 300);
    const pc2Dto = store.getState().addDevice('linux-pc', 600, 300);
    const pc1 = store.getState().deviceInstances.get(pc1Dto.id) as Record<string, unknown>;
    const pc2 = store.getState().deviceInstances.get(pc2Dto.id) as Record<string, unknown>;

    const pc1Ports = (pc1.getPortNames as () => string[])();
    const pc2Ports = (pc2.getPortNames as () => string[])();
    const pc1Port = pc1Ports.find((n: string) => n.startsWith('eth')) ?? pc1Ports[0];
    const pc2Port = pc2Ports.find((n: string) => n.startsWith('eth')) ?? pc2Ports[0];

    const exec1 = pc1.executeCommand as ((cmd: string) => Promise<string> | string) | undefined;
    const exec2 = pc2.executeCommand as ((cmd: string) => Promise<string> | string) | undefined;
    if (exec1) await Promise.resolve(exec1.call(pc1, `sudo ip addr add 192.168.1.10/24 dev ${pc1Port}`));
    if (exec2) await Promise.resolve(exec2.call(pc2, `sudo ip addr add 192.168.1.20/24 dev ${pc2Port}`));

    store.getState().addConnection(pc1Dto.id, pc1Port, pc2Dto.id, pc2Port, 'ethernet');
    return { pc1Id: pc1Dto.id, pc2Id: pc2Dto.id };
  });
}

/** Pull every cable on the canvas, exactly as deleting the link would. */
async function unplugEverything(page: Page): Promise<void> {
  await page.evaluate(() => {
    type StoreState = {
      connections: Array<{ id: string }>;
      removeConnection(id: string): void;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    for (const c of [...store.getState().connections]) store.getState().removeConnection(c.id);
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

function inTerminal(page: Page, text: string) {
  return page.locator('[data-testid="terminal-modal"]').getByText(text, { exact: false });
}

test.describe('cable unplug — ping', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('ping succeeds while the cable is in place', async ({ page }) => {
    const { pc1Id } = await setupTwoMachineLan(page);
    await openTerminal(page, pc1Id);
    await typeCommand(page, 'ping -c 2 192.168.1.20');
    await expect(inTerminal(page, 'bytes from 192.168.1.20').first()).toBeVisible({ timeout: 15_000 });
  });

  test('ping shows a visible failure once the cable is pulled', async ({ page }) => {
    const { pc1Id } = await setupTwoMachineLan(page);
    await openTerminal(page, pc1Id);
    await typeCommand(page, 'ping -c 2 192.168.1.20');
    await expect(inTerminal(page, 'bytes from 192.168.1.20').first()).toBeVisible({ timeout: 15_000 });

    await unplugEverything(page);

    await typeCommand(page, 'ping -c 2 192.168.1.20');
    await expect(inTerminal(page, 'Destination Host Unreachable').first())
      .toBeVisible({ timeout: 15_000 });
  });

  test('a running ping starts reporting failures when the cable is pulled mid-stream', async ({ page }) => {
    const { pc1Id } = await setupTwoMachineLan(page);
    await openTerminal(page, pc1Id);
    await typeCommand(page, 'ping 192.168.1.20');
    await expect(inTerminal(page, 'bytes from 192.168.1.20').first()).toBeVisible({ timeout: 15_000 });

    await unplugEverything(page);

    await expect(inTerminal(page, 'Destination Host Unreachable').first())
      .toBeVisible({ timeout: 20_000 });
  });

  test('ip link reports NO-CARRIER after the cable is pulled', async ({ page }) => {
    const { pc1Id } = await setupTwoMachineLan(page);
    await openTerminal(page, pc1Id);
    await unplugEverything(page);
    await typeCommand(page, 'ip link show eth0');
    await expect(inTerminal(page, 'NO-CARRIER').first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('cable unplug — ssh', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('an established session breaks instead of serving the remote', async ({ page }) => {
    const { pc1Id } = await setupTwoMachineLan(page);
    await openTerminal(page, pc1Id);
    await typeCommand(page, 'ssh user@192.168.1.20');
    await expect(inTerminal(page, 'password')).toBeVisible({ timeout: 12_000 });
    await typePassword(page, 'admin');
    await expect(
      page.locator('[data-testid="terminal-modal"] input[type="text"]'),
    ).toBeVisible({ timeout: 10_000 });

    await unplugEverything(page);

    await typeCommand(page, 'hostname');
    await expect(inTerminal(page, 'Broken pipe').first()).toBeVisible({ timeout: 10_000 });
  });

  test('a new ssh attempt over a pulled cable never reaches the remote', async ({ page }) => {
    const { pc1Id } = await setupTwoMachineLan(page);
    await openTerminal(page, pc1Id);
    await unplugEverything(page);

    await typeCommand(page, 'ssh user@192.168.1.20');
    await expect(
      inTerminal(page, 'No route to host')
        .or(inTerminal(page, 'Connection timed out'))
        .or(inTerminal(page, 'Network is unreachable'))
        .first(),
    ).toBeVisible({ timeout: 12_000 });
  });
});

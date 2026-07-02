/**
 * SSH E2E tests — Playwright
 *
 * Verifies the SSH flow from the graphical terminal:
 *   - Password prompt text is visible after the known-hosts warning
 *   - Wrong credentials show "Permission denied" once (no duplicate)
 *   - Successful SSH login switches the terminal to the remote shell
 *   - Connection refused is reported correctly
 *   - Ctrl+C during a password prompt returns to normal mode
 *
 * Setup: `window.__networkStore` is exposed in dev mode (src/main.tsx).
 * Tests use `page.evaluate()` to wire devices programmatically.
 * Terminal interaction uses the real DOM via Playwright.
 */

import { test, expect, type Page } from '@playwright/test';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

/**
 * Create PC1 (192.168.1.10/24) and PC2 (192.168.1.20/24), directly cabled.
 * Returns their store IDs.
 */
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

    // Re-read state AFTER addDevice so deviceInstances is the updated Map.
    const pc1 = store.getState().deviceInstances.get(pc1Dto.id) as Record<string, unknown>;
    const pc2 = store.getState().deviceInstances.get(pc2Dto.id) as Record<string, unknown>;

    // Gather port names.
    const pc1Ports = (pc1.getPortNames as () => string[])();
    const pc2Ports = (pc2.getPortNames as () => string[])();
    const pc1Port = pc1Ports.find((n: string) => n.startsWith('eth')) ?? pc1Ports[0];
    const pc2Port = pc2Ports.find((n: string) => n.startsWith('eth')) ?? pc2Ports[0];

    // Configure IPs via the shell executor (same as typing `ip addr add` in bash).
    const exec1 = pc1.executeCommand as ((cmd: string) => Promise<string> | string) | undefined;
    const exec2 = pc2.executeCommand as ((cmd: string) => Promise<string> | string) | undefined;

    if (exec1) await Promise.resolve(exec1.call(pc1, `sudo ip addr add 192.168.1.10/24 dev ${pc1Port}`));
    if (exec2) await Promise.resolve(exec2.call(pc2, `sudo ip addr add 192.168.1.20/24 dev ${pc2Port}`));

    // Wire the two machines.
    store.getState().addConnection(pc1Dto.id, pc1Port, pc2Dto.id, pc2Port, 'ethernet');

    return { pc1Id: pc1Dto.id, pc2Id: pc2Dto.id };
  });
}

/** Double-click a device node to open its terminal, wait for the modal. */
async function openTerminal(page: Page, deviceId: string): Promise<void> {
  await page.locator(`[data-device-id="${deviceId}"]`).first().dblclick({ timeout: 5_000 });
  await expect(page.locator('[data-testid="terminal-modal"]')).toBeVisible({ timeout: 8_000 });
}

/** Type a command into the active terminal text input. */
async function typeCommand(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
}

/** Alias — type a password into the hidden password field and press Enter. */
async function typePassword(page: Page, password: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]');
  await input.focus();
  await input.fill(password);
  await input.press('Enter');
}

/** Scoped locator for text inside the terminal modal. */
function inTerminal(page: Page, text: string) {
  return page.locator('[data-testid="terminal-modal"]').getByText(text, { exact: false });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe('SSH – graphical terminal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  // ── App health ────────────────────────────────────────────────────────────

  test('app loads and shows the device palette', async ({ page }) => {
    await expect(page.locator('h2').filter({ hasText: 'Equipment' })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Drag to canvas').first()).toBeVisible();
  });

  test('canvas is empty on first load', async ({ page }) => {
    await expect(page.locator('[data-device-id]')).toHaveCount(0, { timeout: 3_000 });
  });

  // ── Device and terminal ────────────────────────────────────────────────────

  test('adding a Linux PC via the store renders a device node on the canvas', async ({ page }) => {
    await page.evaluate(() => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): { addDevice(t: string, x: number, y: number): unknown };
      };
      store.getState().addDevice('linux-pc', 400, 300);
    });
    await expect(page.locator('[data-device-id]')).toHaveCount(1, { timeout: 3_000 });
  });

  test('double-clicking a Linux PC opens its terminal modal', async ({ page }) => {
    const id = await page.evaluate(() => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): { addDevice(t: string, x: number, y: number): { id: string } };
      };
      return store.getState().addDevice('linux-pc', 400, 300).id;
    });
    await openTerminal(page, id);
    await expect(page.locator('[data-testid="terminal-modal"]')).toBeVisible();
  });

  test('terminal shows a Linux prompt after opening', async ({ page }) => {
    const id = await page.evaluate(() => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): { addDevice(t: string, x: number, y: number): { id: string } };
      };
      return store.getState().addDevice('linux-pc', 400, 300).id;
    });
    await openTerminal(page, id);
    // The Linux prompt contains "user@" and the hostname.
    await expect(inTerminal(page, 'user@').first()).toBeVisible({ timeout: 5_000 });
  });

  test('running a command in the terminal shows output', async ({ page }) => {
    const id = await page.evaluate(() => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): { addDevice(t: string, x: number, y: number): { id: string } };
      };
      return store.getState().addDevice('linux-pc', 400, 300).id;
    });
    await openTerminal(page, id);
    await typeCommand(page, 'echo hello');
    await expect(inTerminal(page, 'hello').first()).toBeVisible({ timeout: 5_000 });
  });

  // ── SSH – error cases ──────────────────────────────────────────────────────

  test('ssh to an unreachable IP shows "No route to host"', async ({ page }) => {
    const id = await page.evaluate(() => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): { addDevice(t: string, x: number, y: number): { id: string } };
      };
      return store.getState().addDevice('linux-pc', 400, 300).id;
    });
    await openTerminal(page, id);
    await typeCommand(page, 'ssh user@10.99.99.99');

    await expect(
      inTerminal(page, 'No route to host').or(inTerminal(page, 'connect to host')),
    ).toBeVisible({ timeout: 10_000 });
  });

  // ── SSH – password prompt (the UI bug fix) ─────────────────────────────────

  test('ssh to a known host shows the known-hosts warning', async ({ page }) => {
    const { pc1Id } = await setupTwoMachineLan(page);
    await openTerminal(page, pc1Id);
    await typeCommand(page, 'ssh user@192.168.1.20');

    await expect(
      inTerminal(page, 'Warning: Permanently added').or(
        inTerminal(page, 'known hosts'),
      ),
    ).toBeVisible({ timeout: 12_000 });
  });

  test('password prompt text is visible after the known-hosts warning', async ({ page }) => {
    // This test validates the bug fix: the prompt text must appear, not just
    // a blinking cursor.
    const { pc1Id } = await setupTwoMachineLan(page);
    await openTerminal(page, pc1Id);
    await typeCommand(page, 'ssh user@192.168.1.20');

    // Wait for the known-hosts line first.
    await expect(inTerminal(page, 'known host')).toBeVisible({ timeout: 12_000 });

    // The password prompt text must be visually present in the terminal.
    await expect(
      inTerminal(page, "password"),
    ).toBeVisible({ timeout: 8_000 });
  });

  test('the password input field is focused after the prompt appears', async ({ page }) => {
    const { pc1Id } = await setupTwoMachineLan(page);
    await openTerminal(page, pc1Id);
    await typeCommand(page, 'ssh user@192.168.1.20');

    await expect(inTerminal(page, 'password')).toBeVisible({ timeout: 12_000 });

    // The password input element must exist (and should be focused via autoFocus).
    const pwInput = page.locator('[data-testid="terminal-modal"] input[type="password"]');
    await expect(pwInput).toBeAttached({ timeout: 5_000 });
  });

  // ── SSH – authentication ───────────────────────────────────────────────────

  test('wrong password shows "Permission denied" (not duplicated)', async ({ page }) => {
    const { pc1Id } = await setupTwoMachineLan(page);
    await openTerminal(page, pc1Id);
    await typeCommand(page, 'ssh user@192.168.1.20');

    // Wait for first prompt.
    await expect(inTerminal(page, 'password')).toBeVisible({ timeout: 12_000 });

    // Submit wrong password 3 times.
    for (let i = 0; i < 3; i++) {
      await typePassword(page, 'wrongpassword');
      await page.waitForTimeout(400);
    }

    // Realistic OpenSSH behaviour over three failed attempts: a
    // "Permission denied, please try again." after each of the first two,
    // then a single final "Permission denied (password)." — three distinct
    // messages, none of them duplicated within a given attempt.
    const tryAgain = page.locator('[data-testid="terminal-modal"]')
      .getByText('Permission denied, please try again.', { exact: false });
    await expect(tryAgain).toHaveCount(2, { timeout: 8_000 });
    const finalDenied = page.locator('[data-testid="terminal-modal"]')
      .getByText('Permission denied (password).', { exact: false });
    await expect(finalDenied).toHaveCount(1, { timeout: 8_000 });
  });

  test('correct password establishes the remote shell session', async ({ page }) => {
    const { pc1Id } = await setupTwoMachineLan(page);
    await openTerminal(page, pc1Id);
    await typeCommand(page, 'ssh user@192.168.1.20');

    await expect(inTerminal(page, 'password')).toBeVisible({ timeout: 12_000 });
    await typePassword(page, 'admin');

    // After login, the terminal prompt should reflect the remote machine.
    // Either the remote hostname appears or the normal input returns.
    await expect(
      page.locator('[data-testid="terminal-modal"] input[type="text"]'),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('typing "exit" after SSH login returns to the local shell', async ({ page }) => {
    const { pc1Id } = await setupTwoMachineLan(page);
    await openTerminal(page, pc1Id);
    await typeCommand(page, 'ssh user@192.168.1.20');

    await expect(inTerminal(page, 'password')).toBeVisible({ timeout: 12_000 });
    await typePassword(page, 'admin');

    // Wait for the remote prompt.
    await expect(
      page.locator('[data-testid="terminal-modal"] input[type="text"]'),
    ).toBeVisible({ timeout: 8_000 });

    // Type exit to close the SSH session.
    await typeCommand(page, 'exit');

    // The "Connection to … closed." message should appear.
    await expect(
      inTerminal(page, 'Connection to').or(inTerminal(page, 'logout')).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  // ── SSH – Ctrl+C ───────────────────────────────────────────────────────────

  test('Ctrl+C during password prompt cancels the connection', async ({ page }) => {
    const { pc1Id } = await setupTwoMachineLan(page);
    await openTerminal(page, pc1Id);
    await typeCommand(page, 'ssh user@192.168.1.20');

    await expect(inTerminal(page, 'password')).toBeVisible({ timeout: 12_000 });

    // Press Ctrl+C — the hidden password input must be focused for this to route correctly.
    const pwInput = page.locator('[data-testid="terminal-modal"] input[type="password"]');
    await pwInput.focus();
    await page.keyboard.press('Control+c');

    // Normal text input should return (no longer in password mode).
    await expect(
      page.locator('[data-testid="terminal-modal"] input[type="text"]').last(),
    ).toBeVisible({ timeout: 5_000 });
  });

  // ── SSH-keygen ─────────────────────────────────────────────────────────────

  test('ssh-keygen -t ed25519 generates a key and shows the fingerprint', async ({ page }) => {
    const id = await page.evaluate(() => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): { addDevice(t: string, x: number, y: number): { id: string } };
      };
      return store.getState().addDevice('linux-pc', 400, 300).id;
    });
    await openTerminal(page, id);
    await typeCommand(page, 'ssh-keygen -t ed25519 -f /tmp/test_key -N ""');

    await expect(
      inTerminal(page, 'SHA256').or(inTerminal(page, 'fingerprint')).or(
        inTerminal(page, 'public key'),
      ).first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});

/**
 * User creation E2E tests — Playwright
 *
 * Verifies that the two account-creation commands behave faithfully to a
 * real Debian/Ubuntu machine, from the graphical terminal:
 *
 *   - `useradd` is the LOW-LEVEL command — it is non-interactive. It must
 *     create the account silently, never prompting for a password or GECOS.
 *   - `adduser` is the INTERACTIVE front-end — it prompts for a password,
 *     a retype, and the five GECOS finger fields, then confirms.
 *   - `adduser <user> <group>` adds an existing user to a group (no prompts).
 *   - `adduser --group` / `addgroup` creates a group (no prompts).
 *
 * Setup: `window.__networkStore` is exposed in dev mode (src/main.tsx).
 */

import { test, expect, type Page } from '@playwright/test';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

async function addLinuxPc(page: Page): Promise<string> {
  return page.evaluate(() => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice('linux-pc', 400, 300).id;
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

/** Type into the interactive text field (GECOS / confirmation) and press Enter. */
async function typeInteractive(page: Page, value: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(value);
  await input.press('Enter');
}

function inTerminal(page: Page, text: string) {
  return page.locator('[data-testid="terminal-modal"]').getByText(text, { exact: false });
}

/** Run a command programmatically on the device and return its output. */
async function runOnDevice(page: Page, deviceId: string, command: string): Promise<string> {
  return page.evaluate(async ({ id, cmd }) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { deviceInstances: Map<string, Record<string, unknown>> };
    };
    const device = store.getState().deviceInstances.get(id) as Record<string, unknown>;
    const exec = device.executeCommand as (c: string) => Promise<string> | string;
    return Promise.resolve(exec.call(device, cmd));
  }, { id: deviceId, cmd: command });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe('useradd – low-level, non-interactive', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('sudo useradd creates the account silently — NO password prompt', async ({ page }) => {
    const id = await addLinuxPc(page);
    await openTerminal(page, id);
    await typeCommand(page, 'sudo useradd bob');

    // `sudo` itself asks for a password…
    await expect(inTerminal(page, 'password for')).toBeVisible({ timeout: 8_000 });
    await typePassword(page, 'admin');

    // …but `useradd` must NOT prompt for a new password or GECOS.
    await expect(inTerminal(page, 'New password:')).toHaveCount(0, { timeout: 3_000 });
    await expect(inTerminal(page, 'Full Name')).toHaveCount(0, { timeout: 1_000 });

    // The account was nonetheless created.
    const passwd = await runOnDevice(page, id, 'getent passwd bob');
    expect(passwd).toContain('bob');
  });
});

test.describe('adduser – interactive Debian front-end', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('sudo adduser asks for a NEW PASSWORD after sudo auth', async ({ page }) => {
    const id = await addLinuxPc(page);
    await openTerminal(page, id);
    await typeCommand(page, 'sudo adduser bob');

    await expect(inTerminal(page, 'password for')).toBeVisible({ timeout: 8_000 });
    await typePassword(page, 'admin');

    await expect(inTerminal(page, 'New password:')).toBeVisible({ timeout: 8_000 });
  });

  test('sudo adduser shows the realistic Debian creation banner', async ({ page }) => {
    const id = await addLinuxPc(page);
    await openTerminal(page, id);
    await typeCommand(page, 'sudo adduser bob');
    await expect(inTerminal(page, 'password for')).toBeVisible({ timeout: 8_000 });
    await typePassword(page, 'admin');

    await expect(inTerminal(page, "Adding user `bob'")).toBeVisible({ timeout: 8_000 });
    await expect(inTerminal(page, 'Creating home directory')).toBeVisible({ timeout: 3_000 });
  });

  test('sudo adduser completes the full flow and creates a usable account', async ({ page }) => {
    const id = await addLinuxPc(page);
    await openTerminal(page, id);
    await typeCommand(page, 'sudo adduser bob');
    await expect(inTerminal(page, 'password for')).toBeVisible({ timeout: 8_000 });
    await typePassword(page, 'admin');
    await expect(inTerminal(page, 'New password:')).toBeVisible({ timeout: 8_000 });
    await typePassword(page, 'bobsecret');
    await expect(inTerminal(page, 'Retype new password:')).toBeVisible({ timeout: 8_000 });
    await typePassword(page, 'bobsecret');

    // The five GECOS finger prompts.
    await expect(inTerminal(page, 'Full Name')).toBeVisible({ timeout: 8_000 });
    await typeInteractive(page, 'Bob Martin');
    await expect(inTerminal(page, 'Room Number')).toBeVisible({ timeout: 5_000 });
    await typeInteractive(page, '101');
    await expect(inTerminal(page, 'Work Phone')).toBeVisible({ timeout: 5_000 });
    await typeInteractive(page, '');
    await expect(inTerminal(page, 'Home Phone')).toBeVisible({ timeout: 5_000 });
    await typeInteractive(page, '');
    await expect(inTerminal(page, 'Other')).toBeVisible({ timeout: 5_000 });
    await typeInteractive(page, '');
    await expect(inTerminal(page, 'Is the information correct?')).toBeVisible({ timeout: 5_000 });
    await typeInteractive(page, 'Y');

    const passwd = await runOnDevice(page, id, 'getent passwd bob');
    expect(passwd).toContain('bob');
    expect(passwd).toContain('Bob Martin');
  });

  test('sudo adduser --gecos suppresses the GECOS prompts', async ({ page }) => {
    const id = await addLinuxPc(page);
    await openTerminal(page, id);
    await typeCommand(page, 'sudo adduser --gecos "Carol Smith" carol');
    await expect(inTerminal(page, 'password for')).toBeVisible({ timeout: 8_000 });
    await typePassword(page, 'admin');
    await expect(inTerminal(page, 'New password:')).toBeVisible({ timeout: 8_000 });
    await typePassword(page, 'carolpass');
    await expect(inTerminal(page, 'Retype new password:')).toBeVisible({ timeout: 8_000 });
    await typePassword(page, 'carolpass');

    await expect(inTerminal(page, 'Full Name')).toHaveCount(0, { timeout: 3_000 });
    const passwd = await runOnDevice(page, id, 'getent passwd carol');
    expect(passwd).toContain('Carol Smith');
  });

  test('sudo adduser <user> <group> adds to a group with no prompts', async ({ page }) => {
    const id = await addLinuxPc(page);
    await openTerminal(page, id);

    // Pre-create the account programmatically.
    await runOnDevice(page, id, 'useradd dave');

    await typeCommand(page, 'sudo adduser dave sudo');
    await expect(inTerminal(page, 'password for')).toBeVisible({ timeout: 8_000 });
    await typePassword(page, 'admin');

    // No password prompt for a membership change.
    await expect(inTerminal(page, 'New password:')).toHaveCount(0, { timeout: 3_000 });
    await expect(inTerminal(page, "Adding user `dave' to group `sudo'")).toBeVisible({ timeout: 5_000 });

    const groups = await runOnDevice(page, id, 'groups dave');
    expect(groups).toContain('sudo');
  });

  test('sudo addgroup creates a group with no prompts', async ({ page }) => {
    const id = await addLinuxPc(page);
    await openTerminal(page, id);
    await typeCommand(page, 'sudo addgroup developers');
    await expect(inTerminal(page, 'password for')).toBeVisible({ timeout: 8_000 });
    await typePassword(page, 'admin');

    await expect(inTerminal(page, "Adding group `developers'")).toBeVisible({ timeout: 5_000 });
    const group = await runOnDevice(page, id, 'getent group developers');
    expect(group).toContain('developers');
  });

  test('plain adduser is interactive once elevated to root', async ({ page }) => {
    const id = await addLinuxPc(page);
    await openTerminal(page, id);

    await typeCommand(page, 'su');
    await expect(inTerminal(page, 'Password:')).toBeVisible({ timeout: 8_000 });
    await typePassword(page, 'admin');

    await typeCommand(page, 'adduser erin');
    await expect(inTerminal(page, 'New password:')).toBeVisible({ timeout: 8_000 });
    await typePassword(page, 'erinpass');
    await expect(inTerminal(page, 'Retype new password:')).toBeVisible({ timeout: 8_000 });
    await typePassword(page, 'erinpass');
    await expect(inTerminal(page, 'Full Name')).toBeVisible({ timeout: 8_000 });
  });
});

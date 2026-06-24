import { test, expect, type Page } from '@playwright/test';
import { buildSshLab, sshLogin, TARGETS } from './helpers/sshLab';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 10_000 });
}

async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice(t, 400, 300).id;
  }, type);
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

async function spanColor(page: Page, text: string): Promise<string> {
  const span = page.locator('[data-testid="terminal-modal"] span').filter({ hasText: text }).last();
  await expect(span).toBeVisible({ timeout: 5_000 });
  return span.evaluate(el => getComputedStyle(el).color);
}

test.describe('Terminal display realism — colours', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('Linux: interactive ls colours directories blue', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCommand(page, 'mkdir zztestdir');
    await typeCommand(page, 'ls');
    await page.waitForTimeout(600);
    const color = await spanColor(page, 'zztestdir');
    expect(color).toMatch(/rgb\((52, 101, 164|114, 159, 207)\)/);
  });

  test('Linux: interactive ls colours executables green', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCommand(page, 'echo "echo hi" > zzrun.sh');
    await typeCommand(page, 'chmod +x zzrun.sh');
    await typeCommand(page, 'ls');
    await page.waitForTimeout(600);
    const color = await spanColor(page, 'zzrun.sh');
    expect(color).toMatch(/rgb\((78, 154, 6|138, 226, 52)\)/);
  });

  test('Linux: ls -l keeps the long-format columns and colours the name', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCommand(page, 'mkdir zzcol');
    await typeCommand(page, 'ls -l');
    await page.waitForTimeout(600);
    const full = await page.locator('[data-testid="terminal-modal"]').innerText();
    expect(full).toMatch(/drwx/);
    const color = await spanColor(page, 'zzcol');
    expect(color).toMatch(/rgb\((52, 101, 164|114, 159, 207)\)/);
  });

  test('Linux: ls colours directories blue over an SSH session', async ({ page }) => {
    test.setTimeout(90_000);
    const lab = await buildSshLab(page);
    await page.locator(`[data-device-id="${lab.linux1}"]`).first().dblclick({ timeout: 5_000 });
    await expect(page.locator('[data-testid="terminal-modal"]')).toBeVisible({ timeout: 8_000 });
    await sshLogin(page, TARGETS.linux2.ip, 'user', 'admin');
    await typeCommand(page, 'mkdir zzsshdir');
    await typeCommand(page, 'ls');
    await page.waitForTimeout(700);
    const color = await spanColor(page, 'zzsshdir');
    expect(color).toMatch(/rgb\((52, 101, 164|114, 159, 207)\)/);
  });
});

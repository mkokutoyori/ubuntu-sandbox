import { test, expect, type Page } from '@playwright/test';

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

async function typeNormal(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
}

async function typePassword(page: Page, value: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]');
  await input.focus();
  await input.fill(value);
  await input.press('Enter');
}

test.describe('Unified input broker — bash read', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('read -p "Q? " ans pauses and captures the answer', async ({ page }) => {
    const id = await addLinuxPc(page);
    await openTerminal(page, id);

    await typeNormal(page, 'read -p "Continue (y/n)? " ans');
    await expect(page.locator('[data-testid="terminal-modal"] input[type="text"]').last())
      .toBeVisible();

    const inputBox = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
    await inputBox.fill('yes');
    await inputBox.press('Enter');

    await typeNormal(page, 'echo answer=$ans');
    await expect(page.locator('[data-testid="terminal-modal"]')).toContainText('answer=yes');
  });

  test('read -s -p masks the input as a password prompt', async ({ page }) => {
    const id = await addLinuxPc(page);
    await openTerminal(page, id);

    await typeNormal(page, 'read -s -p "Pwd: " pw');
    await expect(page.locator('[data-testid="terminal-modal"] input[type="password"]'))
      .toBeVisible({ timeout: 5_000 });

    await typePassword(page, 'hunter2');
    await typeNormal(page, 'echo len=${#pw}');
    await expect(page.locator('[data-testid="terminal-modal"]')).toContainText('len=7');
  });
});

test.describe('Unified input broker — foreground tail -f', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('tail -f streams appended lines and Ctrl+C ends the foreground task', async ({ page }) => {
    const id = await addLinuxPc(page);
    await openTerminal(page, id);

    await typeNormal(page, 'echo seed > /var/log/syslog');
    await typeNormal(page, 'tail -f /var/log/syslog');
    await expect(page.locator('[data-testid="terminal-modal"]')).toContainText('seed');

    await page.evaluate((deviceId) => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): { devices: Array<{ id: string; equipment: { executor?: { vfs?: { writeFile(p: string, c: string, u: number, g: number, m: number, a?: boolean): boolean } } } }> };
      };
      const dev = store.getState().devices.find(d => d.id === deviceId);
      const exec = (dev?.equipment as unknown as { executor?: { vfs?: { writeFile(p: string, c: string, u: number, g: number, m: number, a?: boolean): boolean } } } | undefined)?.executor;
      exec?.vfs?.writeFile('/var/log/syslog', 'live-line\n', 0, 0, 0o022, true);
    }, id);
    await expect(page.locator('[data-testid="terminal-modal"]')).toContainText('live-line');

    const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
    await input.focus();
    await input.press('Control+c');
    await expect(page.locator('[data-testid="terminal-modal"]')).toContainText('^C');
  });
});

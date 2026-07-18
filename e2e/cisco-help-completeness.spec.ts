/**
 * Cisco IOS `?` help completeness through the real terminal modal
 * (audit AUDIT-COHERENCE-CMD-PS-UX-HELP.md §4).
 *
 * Subcommands the handler actually implements must appear in `?` — and the
 * command must then actually run. Previously greedy handlers that delegated
 * to a helper function showed only a bare "WORD" placeholder.
 *
 * Also covers §3: `erase startup-config` typed in the UI really erases the
 * saved configuration (the flow drives the device, it no longer prints a
 * fake "[OK]" without erasing).
 */
import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addRouter(page: Page): Promise<string> {
  return page.evaluate(() => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice('router-cisco', 400, 250).id;
  });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(400);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  const qIdx = command.indexOf('?');
  if (qIdx === -1) {
    await input.fill(command);
    await input.press('Enter');
  } else {
    await input.fill(command.slice(0, qIdx));
    await input.press('?');
    const rest = command.slice(qIdx + 1);
    if (rest.length > 0) {
      await input.pressSequentially(rest);
      await input.press('Enter');
    }
  }
  await page.waitForTimeout(250);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText());
}

async function waitForText(page: Page, needle: string | RegExp, timeout = 6_000): Promise<void> {
  await expect.poll(
    async () => {
      const t = await modalText(page);
      return typeof needle === 'string' ? t.includes(needle) : needle.test(t);
    },
    { timeout },
  ).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.afterEach(async ({ page }) => { await closeTerminal(page); });

test.describe('Cisco IOS ? help completeness through the UI', () => {
  test('show cdp ? lists the delegated subcommands (not just WORD)', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'show cdp ?');
    await waitForText(page, 'neighbors');
    await waitForText(page, 'interface');
    await waitForText(page, 'traffic');
  });

  test('terminal ? lists length / monitor / width', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'terminal ?');
    await waitForText(page, 'length');
    await waitForText(page, 'monitor');
    await waitForText(page, 'width');
  });

  test('show tcp ? lists brief, and the subcommand runs', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'show tcp ?');
    await waitForText(page, 'brief');
    await typeCmd(page, 'show tcp brief');
    // The command executes (no invalid-input marker).
    const text = await modalText(page);
    expect(text).not.toContain('% Invalid input');
  });
});

test.describe('Cisco IOS erase startup-config through the UI really erases', () => {
  test('a saved hostname is gone from show startup-config after UI erase', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'hostname E2E-SAVED');
    await typeCmd(page, 'end');
    // Save (interactive: accept the default destination filename).
    await typeCmd(page, 'copy running-config startup-config');
    await typeCmd(page, ''); // Destination filename [startup-config]?
    await page.waitForTimeout(400);

    await typeCmd(page, 'show startup-config');
    await waitForText(page, 'hostname E2E-SAVED');

    // Erase (interactive: confirm).
    await typeCmd(page, 'erase startup-config');
    await typeCmd(page, ''); // [confirm]
    await page.waitForTimeout(400);

    // Check only the output produced AFTER this point (the scrollback still
    // holds the earlier successful show).
    const beforeFinalShow = (await modalText(page)).length;
    await typeCmd(page, 'show startup-config');
    await page.waitForTimeout(500);
    const delta = (await modalText(page)).slice(beforeFinalShow);
    expect(delta).not.toContain('hostname E2E-SAVED');
    expect(delta).toContain('startup-config is not present');
  });
});

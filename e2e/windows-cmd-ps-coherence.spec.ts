/**
 * cmd ↔ PowerShell state coherence, driven through the real terminal modal
 * (audit AUDIT-COHERENCE-CMD-PS-UX-HELP.md §1).
 *
 * The same in-browser shell a user types into must show ONE device state
 * from both cmd and PowerShell:
 *   - an address configured via netsh (cmd) is visible to Get-NetIPAddress,
 *   - a route added via `route add` (cmd) is visible to Get-NetRoute,
 *   - an IP added via New-NetIPAddress (PS) is visible to ipconfig (cmd),
 *   - PowerShell no longer invents a 192.168.1.10x address or an
 *     Established 8.8.8.8 connection.
 */
import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addDevice(page: Page, type: string, x = 400, y = 300): Promise<string> {
  return page.evaluate(({ type, x, y }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(type, x, y).id;
  }, { type, x, y });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(300);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string | RegExp, timeout = 8_000): Promise<void> {
  await expect.poll(
    async () => {
      const t = await modalText(page);
      return typeof needle === 'string' ? t.includes(needle) : needle.test(t);
    },
    { timeout },
  ).toBe(true);
}

async function enterPowerShell(page: Page): Promise<void> {
  await typeCmd(page, 'powershell');
  await page.waitForTimeout(500);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/', { timeout: 60_000 });
  await waitForStore(page);
});

test.afterEach(async ({ page }) => { await closeTerminal(page); });

test.describe('Windows cmd ↔ PowerShell — one device state, two shells', () => {
  test('address set in cmd (netsh) is visible to PowerShell Get-NetIPAddress', async ({ page }) => {
    const id = await addDevice(page, 'windows-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'netsh interface ip set address "Ethernet 0" static 10.10.20.30 255.255.255.0');
    await enterPowerShell(page);
    await typeCmd(page, 'Get-NetIPAddress -AddressFamily IPv4');
    await waitForText(page, '10.10.20.30');
  });

  test('route added in cmd is visible to PowerShell Get-NetRoute', async ({ page }) => {
    const id = await addDevice(page, 'windows-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'netsh interface ip set address "Ethernet 0" static 10.10.7.5 255.255.255.0');
    await typeCmd(page, 'route add 172.20.9.0 mask 255.255.255.0 10.10.7.1');
    await enterPowerShell(page);
    await typeCmd(page, 'Get-NetRoute');
    await waitForText(page, '172.20.9.0/24');
  });

  test('IP added in PowerShell (New-NetIPAddress) is visible to cmd ipconfig', async ({ page }) => {
    const id = await addDevice(page, 'windows-pc');
    await openTerminal(page, id);
    await enterPowerShell(page);
    await typeCmd(page, 'New-NetIPAddress -InterfaceAlias "Ethernet 0" -IPAddress 10.30.40.50 -PrefixLength 24');
    await typeCmd(page, 'exit'); // back to cmd
    await page.waitForTimeout(400);
    await typeCmd(page, 'ipconfig');
    await waitForText(page, '10.30.40.50');
  });

  test('PowerShell no longer fabricates a 192.168.1.10x address on a bare adapter', async ({ page }) => {
    const id = await addDevice(page, 'windows-pc');
    await openTerminal(page, id);
    await enterPowerShell(page);
    await typeCmd(page, 'Get-NetIPAddress -AddressFamily IPv4');
    await page.waitForTimeout(600);
    const text = await modalText(page);
    expect(text).not.toMatch(/192\.168\.1\.10\d/);
  });

  test('Get-NetTCPConnection no longer fabricates an 8.8.8.8 connection', async ({ page }) => {
    const id = await addDevice(page, 'windows-pc');
    await openTerminal(page, id);
    await enterPowerShell(page);
    await typeCmd(page, 'Get-NetTCPConnection');
    await page.waitForTimeout(600);
    const text = await modalText(page);
    expect(text).not.toContain('8.8.8.8');
  });
});

import { test, expect, type Page } from '@playwright/test';
import { fortiConsoleLogin } from './fortiConsole';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await fortiConsoleLogin(page);
  await page.waitForTimeout(1500);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(200);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 15_000): Promise<void> {
  await expect.poll(async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

async function poserFortiGate(page: Page): Promise<string> {
  return page.evaluate(() => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const created = store.getState().addDevice('firewall-fortinet', 320, 240);
    const device = store.getState().deviceInstances.get(created.id) as Record<string, unknown>;
    (device.powerOn as (() => void) | undefined)?.call(device);
    return created.id;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — horaires et NTP dans le terminal', () => {
  test('`config firewall schedule onetime` est accepte et `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config firewall schedule onetime', 'edit "maintenance"',
      'set start 23:00 2026/12/31', 'set end 01:00 2027/01/01', 'next', 'end',
      'show firewall schedule onetime']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'edit "maintenance"');
    await waitForText(page, 'set start 23:00 2026/12/31');
    await waitForText(page, 'set end 01:00 2027/01/01');
  });

  test('une heure malformee est refusee', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config firewall schedule onetime', 'edit "bancal"',
      'set start 25:99 pas-une-date']) {
      await typeCmd(page, c);
    }

    const texte = await modalText(page);
    expect(texte).toMatch(/Command fail|value parse error|Invalid/i);
    await typeCmd(page, 'abort');
  });

  test('`config firewall schedule group` est accepte et `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config firewall schedule recurring', 'edit "matin"',
      'set day monday', 'set start 08:00', 'set end 12:00', 'next', 'end',
      'config firewall schedule group', 'edit "bureau"',
      'set member "matin"', 'next', 'end', 'show firewall schedule group']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'edit "bureau"');
    await waitForText(page, 'set member "matin"');
  });

  test('`config system ntp` est accepte et `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config system ntp', 'set ntpsync enable', 'set type custom',
      'set syncinterval 60', 'config ntpserver', 'edit 1',
      'set server "203.0.113.53"', 'next', 'end', 'end', 'show system ntp']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'set ntpsync enable');
    await waitForText(page, 'set syncinterval 60');
    await waitForText(page, 'set server "203.0.113.53"');
  });

  test('un NTP custom sans serveur est refuse', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config system ntp', 'set ntpsync enable', 'set type custom', 'end']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'at least one server');
    await typeCmd(page, 'abort');
  });
});

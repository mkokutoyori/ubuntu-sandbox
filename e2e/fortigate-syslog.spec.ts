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

const COLLECTEUR = [
  'config log syslogd setting',
  'set status enable',
  'set server "192.168.1.53"',
  'set facility local7',
  'set port 514',
  'end',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — collecteurs syslog dans le terminal', () => {
  test('`config log syslogd setting` est accepte et `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...COLLECTEUR, 'show log syslogd setting']) await typeCmd(page, c);

    await waitForText(page, 'set status enable');
    await waitForText(page, 'set server "192.168.1.53"');
    await waitForText(page, 'set facility local7');
  });

  test('`config log syslogd filter` est un chemin SOEUR, pas un enfant', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config log syslogd filter', 'set severity emergency', 'end',
      'show log syslogd filter']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'set severity emergency');
  });

  test('les quatre collecteurs existent', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config log syslogd2 setting', 'set status enable',
      'set server "192.168.1.54"', 'end',
      'config log syslogd4 setting', 'set status enable',
      'set server "192.168.1.56"', 'end', 'show log syslogd4 setting']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'set server "192.168.1.56"');
  });

  test('`set status disable` est accepte et rendu', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...COLLECTEUR, 'config log syslogd setting',
      'set status disable', 'end', 'show log syslogd setting']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'set status disable');
  });

  test('un format inconnu est refuse', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config log syslogd setting', 'set format pas-un-format']) {
      await typeCmd(page, c);
    }

    const texte = await modalText(page);
    expect(texte).toMatch(/Command fail|value parse error|Invalid/i);
    await typeCmd(page, 'abort');
  });
});

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
  await page.waitForTimeout(250);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 10_000): Promise<void> {
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

const LABO = [
  'config system interface',
  'edit port1',
  'set mode static',
  'set ip 192.168.1.1 255.255.255.0',
  'next',
  'edit port2',
  'set mode static',
  'set ip 203.0.113.1 255.255.255.0',
  'next',
  'end',
  'config router static',
  'edit 1',
  'set dst 0.0.0.0 0.0.0.0',
  'set gateway 203.0.113.254',
  'set device port2',
  'next',
  'end',
  'config firewall policy',
  'edit 1',
  'set srcintf port1',
  'set dstintf port2',
  'set srcaddr all',
  'set dstaddr all',
  'set action accept',
  'set service ALL',
  'set nat enable',
  'set logtraffic all',
  'next',
  'end',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — diagnostic et journaux dans le terminal', () => {
  test('`get system status` lit la machine, pas une constante', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'get system status');
    await waitForText(page, 'Operation Mode: NAT');

    const vu = await modalText(page);
    expect(vu).toMatch(/Hostname: FW\d+/);
    expect(vu).toContain('Current virtual domain: root');
    expect(vu).toMatch(/Serial-Number: FGVMEV\d{10}/);
  });

  test('`get router info routing-table all` rend la route configuree', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    for (const c of LABO) await typeCmd(page, c);

    await typeCmd(page, 'get router info routing-table all');
    await waitForText(page, 'Codes: K - kernel, C - connected, S - static');

    const vu = await modalText(page);
    expect(vu).toContain('via 203.0.113.254, port2');
    expect(vu).toContain('192.168.1.0/24 is directly connected, port1');
  });

  test('`diagnose firewall iprope list` rend la politique compilee', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    for (const c of LABO) await typeCmd(page, c);

    await typeCmd(page, 'diagnose firewall iprope list');
    await waitForText(page, 'policy group: 00100004');

    const vu = await modalText(page);
    expect(vu).toContain('policy id=1 action=allow');
    expect(vu).toContain('hit count:0');
  });

  test('`diagnose sys session list` rend un total meme a vide', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'diagnose sys session list');
    await waitForText(page, 'total session 0');
  });

  test('`execute log display` le dit quand rien ne correspond', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'execute log display');
    await waitForText(page, 'No matching log data.');
  });

  test('`diagnose ?` annonce les familles de diagnostic', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'diagnose ?');
    await waitForText(page, 'System diagnostics.');

    const vu = await modalText(page);
    expect(vu).toContain('Debug facility.');
    expect(vu).toContain('Packet sniffer.');
  });

  test('la palette ne badge plus le FortiGate comme limite', async ({ page }) => {
    const badge = page.locator('button', { hasText: 'FortiGate' }).first();
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).not.toContainText('Limited');
  });
});

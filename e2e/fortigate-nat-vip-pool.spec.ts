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

const INTERFACES = [
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
];

const VIP = [
  'config firewall vip',
  'edit VIP_WEB',
  'set extip 203.0.113.100',
  'set mappedip 192.168.1.10',
  'set extintf port2',
  'set portforward enable',
  'set protocol tcp',
  'set extport 8080',
  'set mappedport 80',
  'next',
  'end',
];

const POOL = [
  'config firewall ippool',
  'edit POOL_SORTIE',
  'set startip 203.0.113.200',
  'set endip 203.0.113.210',
  'next',
  'end',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — VIP, pools et NAT central dans le terminal', () => {
  test('une VIP se declare et se relit telle qu\'elle a ete tapee', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    for (const c of INTERFACES) await typeCmd(page, c);
    for (const c of VIP) await typeCmd(page, c);

    await typeCmd(page, 'show firewall vip');
    await waitForText(page, 'edit "VIP_WEB"');

    const vu = await modalText(page);
    expect(vu).toContain('set extip 203.0.113.100');
    expect(vu).toContain('set mappedip "192.168.1.10"');
    expect(vu).toContain('set extport 8080');
    expect(vu).toContain('set mappedport 80');
  });

  test('`get` annonce l\'ARP mandataire arme par defaut sur un pool', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    for (const c of POOL) await typeCmd(page, c);

    await typeCmd(page, 'get firewall ippool POOL_SORTIE');
    await waitForText(page, 'arp-reply');

    const vu = await modalText(page);
    expect(vu).toMatch(/type\s+: overload/);
    expect(vu).toMatch(/arp-reply\s+: enable/);
  });

  test('`?` propose la VIP comme destination d\'une politique', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    for (const c of INTERFACES) await typeCmd(page, c);
    for (const c of VIP) await typeCmd(page, c);

    await typeCmd(page, 'config firewall policy');
    await typeCmd(page, 'edit 1');
    await typeCmd(page, 'set dstaddr ?');
    await waitForText(page, 'VIP_WEB');
  });

  test('`central-nat enable` retire `set nat` de la politique', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config system settings');
    await typeCmd(page, 'set central-nat enable');
    await typeCmd(page, 'end');

    await typeCmd(page, 'config firewall policy');
    await typeCmd(page, 'edit 1');
    await typeCmd(page, 'set nat enable');
    await waitForText(page, 'Command fail');
  });

  test('une route de politique se declare et se relit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    for (const c of INTERFACES) await typeCmd(page, c);

    await typeCmd(page, 'config router policy');
    await typeCmd(page, 'edit 1');
    await typeCmd(page, 'set input-device port1');
    await typeCmd(page, 'set src 192.168.1.0/24');
    await typeCmd(page, 'set output-device port2');
    await typeCmd(page, 'set gateway 203.0.113.254');
    await typeCmd(page, 'next');
    await typeCmd(page, 'end');

    await typeCmd(page, 'show router policy');
    await waitForText(page, 'set gateway 203.0.113.254');

    const vu = await modalText(page);
    expect(vu).toContain('set input-device "port1"');
    expect(vu).toContain('set output-device "port2"');
  });
});

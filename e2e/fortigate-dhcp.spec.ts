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

const INTERFACE = [
  'config system interface',
  'edit "port1"', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next', 'end',
];

const SERVEUR = [
  'config system dhcp server',
  'edit 1',
  'set interface "port1"',
  'set default-gateway 192.168.1.1',
  'set netmask 255.255.255.0',
  'set dns-server1 192.168.1.53',
  'set lease-time 3600',
  'config ip-range', 'edit 1',
  'set start-ip 192.168.1.100', 'set end-ip 192.168.1.150', 'next', 'end',
  'next', 'end',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — serveur DHCP dans le terminal', () => {
  test('`config system dhcp server` est accepte et `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACE, ...SERVEUR, 'show system dhcp server']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'set interface "port1"');
    await waitForText(page, 'set start-ip 192.168.1.100');
    await waitForText(page, 'set end-ip 192.168.1.150');
  });

  test('la plage et la passerelle sont reproduites telles que tapees', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACE, ...SERVEUR, 'show system dhcp server']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'set default-gateway 192.168.1.1');
    await waitForText(page, 'set dns-server1 192.168.1.53');
  });

  test('`execute dhcp lease-list` repond, meme sans bail', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACE, ...SERVEUR, 'execute dhcp lease-list']) {
      await typeCmd(page, c);
    }

    const texte = await modalText(page);
    expect(texte).not.toContain('is not implemented in this simulator');
  });

  test('`set status disable` est accepte et rendu', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [...INTERFACE, ...SERVEUR,
      'config system dhcp server', 'edit 1', 'set status disable', 'next', 'end',
      'show system dhcp server']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'set status disable');
  });

  test('`set mode dhcp` sur une interface est accepte', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config system interface', 'edit "port2"', 'set mode dhcp',
      'next', 'end', 'show system interface']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'set mode dhcp');
  });
});

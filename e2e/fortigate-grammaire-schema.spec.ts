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

const POLITIQUE = [
  'config firewall policy',
  'edit 1',
  'set srcintf port1',
  'set dstintf port2',
  'set srcaddr all',
  'set dstaddr all',
  'set action accept',
  'set service ALL',
  'set nat enable',
  'next',
  'end',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — la grammaire hierarchique dans le terminal', () => {
  test('`show` rend le modifie, `show full-configuration` rend tout', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);
    for (const c of POLITIQUE) await typeCmd(page, c);

    await typeCmd(page, 'show firewall policy');
    await waitForText(page, 'set srcintf "port1"');
    const court = await modalText(page);
    expect(court).toContain('set nat enable');
    expect(court).not.toContain('set status enable');

    await typeCmd(page, 'show full-configuration firewall policy');
    await waitForText(page, 'set status enable');
    const complet = await modalText(page);
    expect(complet).toContain('set logtraffic utm');
    expect(complet).toContain('set inspection-mode flow');
  });

  test('l\'invite descend et remonte avec la pile', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config firewall address');
    await waitForText(page, '(address)');

    await typeCmd(page, 'edit "SRV_WEB"');
    await waitForText(page, '(SRV_WEB)');

    await typeCmd(page, 'set subnet 192.168.50.10 255.255.255.255');
    await typeCmd(page, 'next');
    await waitForText(page, '(address)');

    await typeCmd(page, 'end');
    await typeCmd(page, 'show firewall address');
    await waitForText(page, 'edit "SRV_WEB"');
  });

  test('un refus nomme ce qui manque', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config firewall policy');
    await typeCmd(page, 'edit 1');
    await typeCmd(page, 'set zorglub 1');

    await waitForText(page, 'command parse error');
    expect(await modalText(page)).toContain('NOTE:');
  });

  test('`abort` annule un objet qui vient d\'etre cree', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config firewall address');
    await typeCmd(page, 'edit "TEMPORAIRE"');
    await typeCmd(page, 'set subnet 10.0.0.1 255.255.255.255');
    await typeCmd(page, 'abort');
    await typeCmd(page, 'show firewall address');

    await page.waitForTimeout(500);
    const vu = await modalText(page);
    const apresShow = vu.slice(vu.lastIndexOf('show firewall address'));
    expect(apresShow).not.toContain('TEMPORAIRE');
  });
});

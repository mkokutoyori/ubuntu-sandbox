import { test, expect, type Page } from '@playwright/test';
import { fortiConsoleLogin } from './fortiConsole';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
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

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]')
    .waitFor({ state: 'visible', timeout: 10_000 });
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

async function waitForText(page: Page, needle: string, timeout = 10_000): Promise<void> {
  await expect.poll(
    async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

function tail(vue: string, ancre: string): string {
  return vue.slice(vue.lastIndexOf(ancre));
}

async function declarerGrappe(page: Page, methode: string): Promise<void> {
  for (const line of [
    'config firewall vip', 'edit "SLB"',
    'set type server-load-balance',
    'set extip 203.0.113.100',
    'set extintf "port2"',
    'set server-type tcp',
    `set ldb-method ${methode}`,
    'set extport 80',
    'config realservers',
    'edit 1', 'set ip 192.168.1.10', 'set port 80', 'next',
    'edit 2', 'set ip 192.168.1.11', 'set port 80', 'next',
    'end', 'next', 'end',
  ]) await typeCmd(page, line);
}

test.describe('FortiGate — le VIP de repartition dans un vrai terminal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('la grappe se declare et se relit', async ({ page }) => {
    test.setTimeout(90_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await declarerGrappe(page, 'round-robin');
    await typeCmd(page, 'show firewall vip "SLB"');
    await waitForText(page, 'show firewall vip');

    const rendu = tail(await modalText(page), 'show firewall vip "SLB"');
    expect(rendu).toContain('set type server-load-balance');
    expect(rendu).toContain('set ldb-method round-robin');
    expect(rendu).toContain('config realservers');
    expect(rendu).toContain('set ip 192.168.1.10');
    expect(rendu).toContain('set ip 192.168.1.11');
  });

  test('`config firewall ldb-monitor` porte ses defauts reels',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      for (const line of [
        'config firewall ldb-monitor', 'edit "HC"', 'next', 'end',
      ]) await typeCmd(page, line);
      await typeCmd(page, 'show full-configuration firewall ldb-monitor "HC"');
      await waitForText(page, 'set type ping');

      const rendu = tail(await modalText(page), 'show full-configuration');
      expect(rendu).toContain('set interval 10');
      expect(rendu).toContain('set timeout 2');
      expect(rendu).toContain('set retry 3');
    });

  test('`least-rtt` est refuse en nommant sa brique', async ({ page }) => {
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const line of [
      'config firewall vip', 'edit "SLB"', 'set type server-load-balance',
    ]) await typeCmd(page, line);
    await typeCmd(page, 'set ldb-method least-rtt');
    await waitForText(page, 'wire clock');

    expect(await modalText(page)).toContain('least-rtt');
  });

  test('un moniteur applicatif est refuse plutot qu accepte inerte',
    async ({ page }) => {
      const id = await poserFortiGate(page);
      await openTerminal(page, id);

      for (const line of [
        'config firewall ldb-monitor', 'edit "HC"',
      ]) await typeCmd(page, line);
      await typeCmd(page, 'set type http');
      await waitForText(page, 'alive without asking');

      expect(await modalText(page)).toContain('ICMP echo');
    });
});

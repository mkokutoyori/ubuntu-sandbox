import { test, expect, type Page } from '@playwright/test';
import { fortiConsoleLogin } from './fortiConsole';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function poser(page: Page, type: string, x: number): Promise<string> {
  return page.evaluate(({ kind, at }) => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const created = store.getState().addDevice(kind, at, 240);
    const device = store.getState().deviceInstances.get(created.id) as Record<string, unknown>;
    (device.powerOn as (() => void) | undefined)?.call(device);
    return created.id;
  }, { kind: type, at: x });
}

async function cabler(page: Page, fw: string, pc: string): Promise<void> {
  await page.evaluate(({ a, b }) => {
    type S = {
      addConnection(x: string, xi: string, y: string, yi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    store.getState().addConnection(a, 'port1', b, 'eth0', 'ethernet');
  }, { a: fw, b: pc });
  await page.waitForTimeout(500);
}

async function openTerminal(page: Page, id: string, forti: boolean): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]')
    .waitFor({ state: 'visible', timeout: 10_000 });
  if (forti) await fortiConsoleLogin(page);
  await page.waitForTimeout(1200);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]')
    .waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForTimeout(300);
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

async function waitForText(page: Page, needle: string, timeout = 12_000): Promise<void> {
  await expect.poll(
    async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

const CONFIGURATION = [
  'config system interface',
  'edit "port1"',
  'set mode static',
  'set ip 192.168.1.1 255.255.255.0',
  'set allowaccess ping http https ssh',
  'next',
  'end',
  'config system admin',
  'edit "admin"',
  'set password "Secret123"',
  'set accprofile "super_admin"',
  'next',
  'end',
];

test.describe('FortiGate — le plan d\'administration HTTP/HTTPS', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('le port HTTP redirige vers HTTPS, et l\'API CMDB exige une session',
    async ({ page }) => {
      const fw = await poser(page, 'firewall-fortinet', 420);
      const pc = await poser(page, 'linux-pc', 180);
      await cabler(page, fw, pc);

      await openTerminal(page, fw, true);
      for (const ligne of CONFIGURATION) await typeCmd(page, ligne);
      await closeTerminal(page);

      await openTerminal(page, pc, false);
      for (const ligne of [
        'ip link set eth0 up',
        'ip addr add 192.168.1.10/24 dev eth0',
        'curl -s -i http://192.168.1.1/',
      ]) await typeCmd(page, ligne);

      await waitForText(page, 'Location: https://192.168.1.1/');

      await typeCmd(page, 'curl -k -s -i https://192.168.1.1/api/v2/cmdb/system/admin');
      await waitForText(page, '401');
    });

  test('apres `/logincheck`, l\'API rend l\'administrateur cree a la CLI',
    async ({ page }) => {
      const fw = await poser(page, 'firewall-fortinet', 420);
      const pc = await poser(page, 'linux-pc', 180);
      await cabler(page, fw, pc);

      await openTerminal(page, fw, true);
      for (const ligne of [
        ...CONFIGURATION,
        'config system admin',
        'edit "auditeur"',
        'set password "Audit123"',
        'set accprofile "prof_admin"',
        'next',
        'end',
      ]) await typeCmd(page, ligne);
      await closeTerminal(page);

      await openTerminal(page, pc, false);
      for (const ligne of [
        'ip link set eth0 up',
        'ip addr add 192.168.1.10/24 dev eth0',
        'curl -k -s -c /tmp/jar -X POST '
          + '-d "username=admin&secretkey=Secret123&ajax=1" https://192.168.1.1/logincheck',
        'curl -k -s -b /tmp/jar https://192.168.1.1/api/v2/cmdb/system/admin',
      ]) await typeCmd(page, ligne);

      await waitForText(page, '"name":"auditeur"');
      await waitForText(page, '"accprofile":"prof_admin"');
    });
});

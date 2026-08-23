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

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — inspection et UTM dans le terminal', () => {
  test('un profil antivirus se declare et le `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config antivirus profile', 'edit "AV"',
      'config http', 'set av-scan monitor', 'end',
      'next', 'end', 'show antivirus profile',
    ]) await typeCmd(page, c);

    await waitForText(page, 'edit "AV"');
    await waitForText(page, 'config http');
    await waitForText(page, 'set av-scan monitor');
  });

  test('`deep-inspection` est refuse en nommant la brique absente', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config firewall ssl-ssh-profile', 'edit "SSL"',
      'config https', 'set status deep-inspection',
    ]) await typeCmd(page, c);

    await waitForText(page, 'Command fail');
    await waitForText(page, 'certificate-inspection');
  });

  test('`certificate-inspection` est acceptee et rendue', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config firewall ssl-ssh-profile', 'edit "SSL"',
      'config https', 'set status certificate-inspection', 'end',
      'next', 'end', 'show firewall ssl-ssh-profile',
    ]) await typeCmd(page, c);

    await waitForText(page, 'set status certificate-inspection');
  });

  test('la table d`URL referencee se declare comme sur un vrai FortiGate', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config webfilter urlfilter', 'edit 1', 'set name "BLOQUES"',
      'config entries', 'edit 1',
      'set url "interdit.test"', 'set action block',
      'next', 'end', 'next', 'end',
      'config webfilter profile', 'edit "WEB"',
      'config web', 'set urlfilter-table 1', 'end',
      'next', 'end', 'show webfilter profile',
    ]) await typeCmd(page, c);

    await waitForText(page, 'config web');
    await waitForText(page, 'set urlfilter-table 1');
  });

  test('`set av-profile` est refuse tant que `utm-status` est absent', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config antivirus profile', 'edit "AV"', 'next', 'end',
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set av-profile "AV"',
    ]) await typeCmd(page, c);

    await waitForText(page, 'Command fail');
  });

  test('`config ?` propose les branches UTM', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'config ?');

    await waitForText(page, 'antivirus');
    await waitForText(page, 'webfilter');
  });
});

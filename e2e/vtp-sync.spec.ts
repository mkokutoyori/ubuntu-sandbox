import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function closeTerminal(page: Page): Promise<void> {
  const closeBtn = page.locator('[data-testid="terminal-modal"] button[title="Close"]').last();
  if (await closeBtn.count() > 0) await closeBtn.click().catch(() => {});
  await page.waitForTimeout(300);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(200);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

interface VtpLab { sw1: string; sw2: string }

async function buildVtpLab(page: Page): Promise<VtpLab> {
  return page.evaluate(async () => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const sw1 = store.getState().addDevice('switch-cisco', 250, 250);
    const sw2 = store.getState().addDevice('switch-cisco', 550, 250);
    store.getState().addConnection(sw1.id, 'FastEthernet0/1', sw2.id, 'FastEthernet0/1', 'ethernet');
    return { sw1: sw1.id, sw2: sw2.id };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.afterEach(async ({ page }) => { await closeTerminal(page); });

test.describe('VTP — client learns server VLANs without requiring a later server-side VLAN change', () => {
  test('SW-CLIENT shows all five VLANs immediately after joining the domain', async ({ page }) => {
    const { sw1, sw2 } = await buildVtpLab(page);

    await openTerminal(page, sw1);
    for (const c of [
      'enable',
      'configure terminal',
      'hostname SW-SERVER',
      'vlan 10', 'name COMPTA', 'exit',
      'vlan 20', 'name DEV', 'exit',
      'vlan 30', 'name IT', 'exit',
      'vlan 40', 'name INTERNAL-CONTROL', 'exit',
      'vlan 50', 'name RH', 'exit',
      'vtp mode server',
      'vtp version 2',
      'vtp domain LAB',
      'vtp password secret123',
      'vtp pruning',
      'interface fa0/1',
      'switchport trunk encapsulation dot1q',
      'switchport mode trunk',
      'no shutdown',
      'end',
    ]) await typeCmd(page, c);
    await closeTerminal(page);

    await openTerminal(page, sw2);
    for (const c of [
      'enable',
      'configure terminal',
      'hostname SW-CLIENT',
      'vtp mode client',
      'vtp version 2',
      'vtp domain LAB',
      'vtp password secret123',
      'interface fa0/1',
      'switchport trunk encapsulation dot1q',
      'switchport mode trunk',
      'no shutdown',
      'end',
    ]) await typeCmd(page, c);

    await typeCmd(page, 'show vtp status');
    await expect.poll(() => modalText(page)).toContain('LAB');

    await typeCmd(page, 'show vlan brief');
    const text = await modalText(page);
    for (const vlanLine of ['10   COMPTA', '20   DEV', '30   IT', '40   INTERNAL-CONTROL', '50   RH']) {
      expect(text).toContain(vlanLine);
    }
  });
});

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

async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').last().click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 10_000 });
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

async function waitForText(page: Page, needle: string, timeout = 20_000): Promise<void> {
  await expect.poll(async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

interface Lab {
  fgtA: string;
  fgtB: string;
  pcA: string;
}

async function poserLaboratoire(page: Page): Promise<Lab> {
  return page.evaluate(() => {
    type Device = Record<string, unknown> & {
      powerOn?: () => void;
      getPort?: (name: string) => unknown;
    };
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
      deviceInstances: Map<string, Device>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const state = () => store.getState();

    const make = (type: string, x: number, y: number): string => {
      const created = state().addDevice(type, x, y);
      state().deviceInstances.get(created.id)?.powerOn?.();
      return created.id;
    };

    const fgtA = make('firewall-fortinet', 260, 220);
    const fgtB = make('firewall-fortinet', 620, 220);
    const pcA = make('linux-pc', 260, 400);
    const pcB = make('linux-pc', 620, 400);

    const cable = (from: string, fromPort: string, to: string, toPort: string) => {
      state().addConnection(from, fromPort, to, toPort, 'ethernet');
    };

    cable(fgtA, 'port2', fgtB, 'port2');
    cable(pcA, 'eth0', fgtA, 'port1');
    cable(pcB, 'eth0', fgtB, 'port1');

    return { fgtA, fgtB, pcA };
  });
}

function configuration(
  lan: string, wan: string, peer: string, name: string, remote: string,
): string[] {
  return [
    'config system interface',
    'edit "port1"', 'set mode static', `set ip ${lan}.1 255.255.255.0`,
    'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static', `set ip ${wan} 255.255.255.0`,
    'set allowaccess ping', 'next', 'end',
    'config vpn ipsec phase1-interface', `edit "${name}"`,
    'set interface "port2"', 'set ike-version 2', `set remote-gw ${peer}`,
    'set psksecret "SecretPartage2026"', 'set proposal aes256-sha256', 'set dhgrp 14',
    'next', 'end',
    'config vpn ipsec phase2-interface', `edit "${name}-p2"`,
    `set phase1name "${name}"`,
    `set src-subnet ${lan}.0 255.255.255.0`,
    `set dst-subnet ${remote}.0 255.255.255.0`,
    'next', 'end',
    'config router static', 'edit 1',
    `set dst ${remote}.0 255.255.255.0`, `set device "${name}"`, 'next', 'end',
    'config firewall policy',
    'edit 1', 'set srcintf "port1"', `set dstintf "${name}"`,
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"', 'next',
    'edit 2', `set srcintf "${name}"`, 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"', 'next', 'end',
  ];
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — le trafic traverse le tunnel', () => {
  test('un poste derriere A joint un poste derriere B, et le tunnel compte les paquets', async ({ page }) => {
    test.setTimeout(180_000);
    const lab = await poserLaboratoire(page);

    await openTerminal(page, lab.fgtA);
    for (const c of configuration('192.168.1', '203.0.113.1', '203.0.113.2', 'vers_b', '192.168.2')) {
      await typeCmd(page, c);
    }
    await closeTerminal(page);

    await openTerminal(page, lab.fgtB);
    for (const c of configuration('192.168.2', '203.0.113.2', '203.0.113.1', 'vers_a', '192.168.1')) {
      await typeCmd(page, c);
    }
    await closeTerminal(page);

    await openTerminal(page, lab.pcA);
    for (const c of [
      'ip link set eth0 up',
      'ip addr add 192.168.1.10/24 dev eth0',
      'ip route add default via 192.168.1.1',
      'ping -c 2 192.168.2.10',
    ]) await typeCmd(page, c);

    await waitForText(page, '0% packet loss', 40_000);
    await closeTerminal(page);

    await openTerminal(page, lab.fgtA);
    await typeCmd(page, 'diagnose vpn tunnel list');
    await waitForText(page, 'name=vers_b');

    const texte = await modalText(page);
    const compteur = /txp=(\d+)/.exec(texte);
    expect(compteur).not.toBeNull();
    expect(Number(compteur![1])).toBeGreaterThan(0);
  });
});

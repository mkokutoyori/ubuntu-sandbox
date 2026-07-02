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
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(250);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string | RegExp, timeout = 8_000): Promise<void> {
  await expect.poll(
    async () => {
      const t = await modalText(page);
      return typeof needle === 'string' ? t.includes(needle) : needle.test(t);
    },
    { timeout },
  ).toBe(true);
}

interface Lab { sw: string; pcA: string; pcB: string; pcM: string }

async function buildLab(page: Page): Promise<Lab> {
  return page.evaluate(async () => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const sw = store.getState().addDevice('switch-huawei', 425, 250);
    const pcA = store.getState().addDevice('linux-pc', 150, 150);
    const pcB = store.getState().addDevice('linux-pc', 700, 150);
    const pcM = store.getState().addDevice('linux-pc', 425, 450);
    const swi = store.getState().deviceInstances.get(sw.id) as Record<string, unknown>;
    const pcAi = store.getState().deviceInstances.get(pcA.id) as Record<string, unknown>;
    const pcBi = store.getState().deviceInstances.get(pcB.id) as Record<string, unknown>;
    const exec = async (dev: Record<string, unknown>, c: string): Promise<void> => {
      const e = dev.executeCommand as ((c: string) => Promise<string> | string) | undefined;
      if (e) await Promise.resolve(e.call(dev, c));
    };
    store.getState().addConnection(pcA.id, 'eth0', sw.id, 'GigabitEthernet0/0/1', 'ethernet');
    store.getState().addConnection(pcB.id, 'eth0', sw.id, 'GigabitEthernet0/0/2', 'ethernet');
    store.getState().addConnection(pcM.id, 'eth0', sw.id, 'GigabitEthernet0/0/8', 'ethernet');
    await exec(pcAi, 'ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await exec(pcBi, 'ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
    for (const c of [
      'system-view',
      'vlan 99', 'quit',
      'interface GigabitEthernet0/0/8',
      'port link-type access',
      'port default vlan 99',
      'quit', 'quit',
    ]) await exec(swi, c);
    return { sw: sw.id, pcA: pcA.id, pcB: pcB.id, pcM: pcM.id };
  });
}

async function injectFromHost(page: Page, hostId: string, command: string): Promise<void> {
  await page.evaluate(async ({ id, command }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
    const dev = store.getState().deviceInstances.get(id) as Record<string, unknown>;
    const e = dev.executeCommand as ((c: string) => Promise<string> | string);
    await Promise.resolve(e.call(dev, command));
  }, { id: hostId, command });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.afterEach(async ({ page }) => { await closeTerminal(page); });

test.describe('Huawei port-mirroring — observe-port + mirror through the real UI', () => {
  test('inbound mirror surfaces ingress ICMP into tcpdump on the observe-port', async ({ page }) => {
    const { sw, pcA, pcM } = await buildLab(page);
    for (const c of [
      'system-view',
      'observe-port 1 interface GigabitEthernet0/0/8',
      'interface GigabitEthernet0/0/1',
      'port-mirroring to observe-port 1 inbound',
      'quit', 'quit',
    ]) await injectFromHost(page, sw, c);

    await openTerminal(page, pcM);
    await typeCmd(page, 'tcpdump -c 1 icmp');
    await waitForText(page, 'listening on eth0');
    await injectFromHost(page, pcA, 'ping -c 1 10.0.0.2');
    await waitForText(page, 'ICMP', 6_000);
    await waitForText(page, /1 packet captured/, 6_000);
  });

  test('display observe-port + display port-mirroring render observe-port and sources', async ({ page }) => {
    const { sw } = await buildLab(page);
    await openTerminal(page, sw);
    await typeCmd(page, 'system-view');
    await typeCmd(page, 'observe-port 3 interface GigabitEthernet0/0/8');
    await typeCmd(page, 'interface GigabitEthernet0/0/1');
    await typeCmd(page, 'port-mirroring to observe-port 3 both');
    await typeCmd(page, 'quit');
    await typeCmd(page, 'display observe-port');
    await waitForText(page, /\s+3\s+:\s+GigabitEthernet0\/0\/8/);
    await typeCmd(page, 'display port-mirroring');
    await waitForText(page, 'Observe-port 3 : GigabitEthernet0/0/8');
    await waitForText(page, 'GigabitEthernet0/0/1 both');
  });

  test('undo port-mirroring stops the stream — destination tcpdump stays quiet', async ({ page }) => {
    const { sw, pcA, pcM } = await buildLab(page);
    for (const c of [
      'system-view',
      'observe-port 4 interface GigabitEthernet0/0/8',
      'interface GigabitEthernet0/0/1',
      'port-mirroring to observe-port 4 both',
      'undo port-mirroring to observe-port 4',
      'quit', 'quit',
    ]) await injectFromHost(page, sw, c);

    await openTerminal(page, pcM);
    await typeCmd(page, 'tcpdump -c 1 icmp');
    await waitForText(page, 'listening on eth0');
    await injectFromHost(page, pcA, 'ping -c 2 10.0.0.2');
    await page.waitForTimeout(1_500);
    const text = await modalText(page);
    expect(text).not.toContain('ICMP');
    expect(text).not.toContain('1 packet captured');
  });
});

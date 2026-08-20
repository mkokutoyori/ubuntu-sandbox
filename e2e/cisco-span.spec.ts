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

interface SpanLab { sw: string; pcA: string; pcB: string; pcM: string }

async function buildSpanLab(page: Page): Promise<SpanLab> {
  return page.evaluate(async () => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const sw = store.getState().addDevice('switch-cisco', 425, 250);
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
    store.getState().addConnection(pcA.id, 'eth0', sw.id, 'FastEthernet0/1', 'ethernet');
    store.getState().addConnection(pcB.id, 'eth0', sw.id, 'FastEthernet0/2', 'ethernet');
    store.getState().addConnection(pcM.id, 'eth0', sw.id, 'FastEthernet0/8', 'ethernet');
    await exec(pcAi, 'ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await exec(pcBi, 'ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
    // Isolate mirror destination on its own VLAN — only SPAN will reach it.
    for (const c of [
      'enable', 'configure terminal',
      'vlan 99', 'exit',
      'interface FastEthernet0/8',
      'switchport mode access',
      'switchport access vlan 99',
      'end',
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

test.describe('Cisco SPAN — monitor session through the real UI', () => {
  test('rx mirror surfaces source-port ICMP into tcpdump on the destination PC', async ({ page }) => {
    const { sw, pcA, pcM } = await buildSpanLab(page);
    for (const c of [
      'enable', 'configure terminal',
      'monitor session 1 source interface FastEthernet0/1 rx',
      'monitor session 1 destination interface FastEthernet0/8',
      'end',
    ]) await injectFromHost(page, sw, c);

    await openTerminal(page, pcM);
    await typeCmd(page, 'tcpdump -c 1 icmp');
    await waitForText(page, 'listening on eth0');

    await injectFromHost(page, pcA, 'ping -c 1 10.0.0.2');
    await waitForText(page, 'ICMP', 6_000);
    await waitForText(page, /1 packet captured/, 6_000);
  });

  test('show monitor session N renders source + destination through the switch CLI', async ({ page }) => {
    const { sw } = await buildSpanLab(page);
    await openTerminal(page, sw);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'monitor session 4 source interface FastEthernet0/1 both');
    await typeCmd(page, 'monitor session 4 destination interface FastEthernet0/8');
    await typeCmd(page, 'end');
    await typeCmd(page, 'show monitor session 4');
    await waitForText(page, 'Session 4');
    await waitForText(page, /Both\s+:\s+FastEthernet0\/1/);
    await waitForText(page, /Destination Ports\s+:\s+FastEthernet0\/8/);
  });

  test('no monitor session removes the mirror — tcpdump sees nothing afterwards', async ({ page }) => {
    const { sw, pcA, pcM } = await buildSpanLab(page);
    for (const c of [
      'enable', 'configure terminal',
      'monitor session 7 source interface FastEthernet0/1 both',
      'monitor session 7 destination interface FastEthernet0/8',
      'no monitor session 7',
      'end',
    ]) await injectFromHost(page, sw, c);

    await openTerminal(page, pcM);
    // Filter to ICMP: STP BPDUs reach every access port naturally and
    // would otherwise satisfy a bare `tcpdump -c 1`.
    await typeCmd(page, 'tcpdump -c 1 icmp');
    await waitForText(page, 'listening on eth0');
    await injectFromHost(page, pcA, 'ping -c 2 10.0.0.2');
    await page.waitForTimeout(1_500);
    const text = await modalText(page);
    expect(text).not.toContain('ICMP');
    expect(text).not.toContain('1 packet captured');
  });
});

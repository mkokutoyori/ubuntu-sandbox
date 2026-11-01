import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 45_000 });
}

async function addDevice(page: Page, type: string, x: number, y: number): Promise<string> {
  return page.evaluate(({ type, x, y }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(type, x, y).id;
  }, { type, x, y });
}

async function cable(page: Page, a: string, aIndex: number, b: string, bIndex: number): Promise<void> {
  await page.evaluate(({ a, aIndex, b, bIndex }) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): {
        addConnection(f: string, fi: string, t: string, ti: string): unknown;
        getDevices(): Array<{ id: string; interfaces: Array<{ name: string }> }>;
      };
    };
    const devices = store.getState().getDevices();
    const src = devices.find((d) => d.id === a)!;
    const dst = devices.find((d) => d.id === b)!;
    store.getState().addConnection(a, src.interfaces[aIndex].name, b, dst.interfaces[bIndex].name);
  }, { a, aIndex, b, bIndex });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForTimeout(200);
}

async function typeCmd(page: Page, command: string, settleMs = 400): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.waitFor({ state: 'attached', timeout: 15_000 });
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(settleMs);
}

async function output(page: Page, command: string, settleMs = 400): Promise<string> {
  await typeCmd(page, 'clear');
  await typeCmd(page, command, settleMs);
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function configure(page: Page, id: string, commands: string[]): Promise<void> {
  await page.evaluate(async ({ id, commands }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
    const device = store.getState().deviceInstances.get(id) as Record<string, unknown>;
    const execute = device.executeCommand as (command: string) => Promise<string> | string;
    for (const command of commands) await Promise.resolve(execute.call(device, command));
  }, { id, commands });
}

test.describe('tcpdump : OSPF et RIP en octets réels', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('un hôte derrière un concentrateur lit les Hello et la base OSPF en -v, ', async ({ page }) => {
    test.slow();
    const host = await addDevice(page, 'linux-pc', 120, 260);
    const hub = await addDevice(page, 'hub', 360, 260);
    const r1 = await addDevice(page, 'router-cisco', 600, 160);
    const r2 = await addDevice(page, 'router-cisco', 600, 360);
    await cable(page, host, 0, hub, 0);
    await cable(page, r1, 0, hub, 1);
    await cable(page, r2, 0, hub, 2);

    await configure(page, host, ['ifconfig eth0 10.9.0.2 netmask 255.255.255.0']);
    await page.evaluate((id) => {
      const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
      const device = store.getState().deviceInstances.get(id) as Record<string, unknown>;
      const execute = device.executeCommand as (command: string) => Promise<string> | string;
      (window as Record<string, unknown>).__capture = Promise.resolve(execute.call(device, 'sudo tcpdump -w /tmp/ospf.cap -c 14'));
    }, host);
    await configure(page, r1, ['enable', 'configure terminal', 'no cdp run', 'interface GigabitEthernet0/0', 'ip address 10.9.0.1 255.255.255.0', 'no shutdown', 'exit',
      'router ospf 1', 'router-id 1.1.1.1', 'network 10.9.0.0 0.0.255.255 area 0', 'exit', 'end']);
    await configure(page, r2, ['enable', 'configure terminal', 'no cdp run', 'interface GigabitEthernet0/0', 'ip address 10.9.0.3 255.255.255.0', 'no shutdown', 'exit',
      'router ospf 1', 'router-id 3.3.3.3', 'network 10.9.0.0 0.0.255.255 area 0', 'exit', 'end']);

    await page.evaluate(async () => { await (window as Record<string, unknown>).__capture; });
    await openTerminal(page, host);
    const text = await output(page, 'tcpdump -nn -v -r /tmp/ospf.cap', 1500);
    expect(text).toContain('OSPFv2, Hello, length 44');
    expect(text).toContain('Router-ID 1.1.1.1, Backbone Area, Authentication Type: none (0)');
    expect(text).toContain('Hello Timer 10s, Dead Timer 40s, Mask 255.255.255.0');
    expect(text).toMatch(/OSPFv2, Database Description, length 32/);
    expect(text).toContain('DD Flags [Init, More, Master]');
  });
});

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

test.describe('IPv6 : un hôte Linux transfère, et les traces le montrent', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('traceroute -6 et tracert -6 traversent une passerelle Linux', async ({ page }) => {
    test.slow();
    const linux = await addDevice(page, 'linux-pc', 120, 260);
    const gateway = await addDevice(page, 'linux-server', 360, 260);
    const far = await addDevice(page, 'linux-pc', 600, 260);
    const windows = await addDevice(page, 'windows-pc', 360, 80);
    await cable(page, linux, 0, gateway, 0);
    await cable(page, gateway, 1, far, 0);
    await cable(page, windows, 0, gateway, 2);

    await configure(page, far, [
      'sudo sysctl -w net.ipv6.conf.all.accept_ra=0',
      'sudo ip -6 addr add 2001:db8:2::2/64 dev eth0',
      'sudo ip -6 route add default via 2001:db8:2::1',
    ]);
    await configure(page, gateway, [
      'sudo ip -6 addr add 2001:db8:1::1/64 dev eth0',
      'sudo ip -6 addr add 2001:db8:2::1/64 dev eth1',
      'sudo ip -6 addr add 2001:db8:3::1/64 dev eth2',
      'sudo sysctl -w net.ipv6.conf.all.forwarding=1',
    ]);
    await configure(page, linux, [
      'sudo sysctl -w net.ipv6.conf.all.accept_ra=0',
      'sudo ip -6 addr add 2001:db8:1::2/64 dev eth0',
      'sudo ip -6 route add default via 2001:db8:1::1',
    ]);

    await openTerminal(page, linux);
    const ping = await output(page, 'ping6 -c 1 2001:db8:2::2', 1500);
    expect(ping).toContain('1 received');
    const trace = await output(page, 'traceroute -6 -n 2001:db8:2::2', 4000);
    expect(trace).toContain('traceroute to 2001:db8:2::2 (2001:db8:2::2), 30 hops max, 80 byte packets');
    expect(trace).toMatch(/ 1 {2}2001:db8:1::1 /);
    expect(trace).toMatch(/ 2 {2}2001:db8:2::2 /);
    const alias = await output(page, 'traceroute6 -n -m 1 2001:db8:2::2', 2500);
    expect(alias).toMatch(/ 1 {2}2001:db8:1::1 /);
    expect(alias).not.toMatch(/ 2 {2}2001:db8:2::2 /);
    await closeTerminal(page);

    await configure(page, windows, [
      'netsh interface ipv6 add address "Ethernet 0" 2001:db8:3::2/64',
      'netsh interface ipv6 add route ::/0 "Ethernet 0" 2001:db8:3::1',
    ]);
    await openTerminal(page, windows);
    const tracert = await output(page, 'tracert -d 2001:db8:2::2', 5000);
    expect(tracert).toContain('Tracing route to 2001:db8:2::2 over a maximum of 30 hops');
    expect(tracert).toMatch(/2001:db8:3::1/);
    expect(tracert).toContain('Trace complete.');
  });
});

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

test.describe('tcpdump : BPDU STP en octets réels', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  for (const [mode, label, header] of [
    ['pvst', '802.1D', 'STP 802.1d, Config, Flags [none], bridge-id 8001.'],
    ['rapid-pvst', '802.1w', 'STP 802.1w, Rapid STP, Flags [Learn, Forward], bridge-id 8001.'],
  ] as const) {
    test(`un hôte relié à un commutateur Cisco (${label}) lit les BPDU avec tcpdump -v`, async ({ page }) => {
      test.slow();
      const host = await addDevice(page, 'linux-pc', 120, 260);
      const sw = await addDevice(page, 'switch-cisco', 420, 260);
      await cable(page, host, 0, sw, 0);
      await page.evaluate((id) => {
        const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
        const device = store.getState().deviceInstances.get(id) as Record<string, unknown>;
        const execute = device.executeCommand as (command: string) => Promise<string> | string;
        (window as Record<string, unknown>).__capture = Promise.resolve(execute.call(device, 'sudo tcpdump -w /tmp/stp.cap -c 3'));
      }, host);
      await configure(page, sw, ['enable', 'configure terminal', 'no cdp run', `spanning-tree mode ${mode}`,
        'interface FastEthernet0/1', 'switchport mode access', 'switchport nonegotiate', 'exit', 'end']);
      await page.evaluate(async () => { await (window as Record<string, unknown>).__capture; });
      await openTerminal(page, host);
      const text = await output(page, 'tcpdump -nn -v -r /tmp/stp.cap', 1500);
      expect(text).toContain(header);
      expect(text).toContain('message-age 0.00s, max-age 20.00s, hello-time 2.00s, forwarding-delay 15.00s');
      expect(text).toContain('root-pathcost 0');
      const linkLevel = await output(page, 'tcpdump -nn -e -r /tmp/stp.cap', 1500);
      expect(linkLevel).toContain('> 01:80:c2:00:00:00, 802.3, length ');
      expect(linkLevel).toContain('LLC, dsap STP (0x42) Individual, ssap STP (0x42) Command, ctrl 0x03: STP');
    });
  }
});

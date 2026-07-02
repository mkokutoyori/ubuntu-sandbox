import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(t, 400, 300).id;
  }, type);
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(400);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 8_000): Promise<void> {
  await expect.poll(async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

/** Build a 2-PC LAN, assign IPs, return device ids. */
async function lan(page: Page): Promise<{ pc1: string; pc2: string }> {
  return page.evaluate(async () => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const pc1 = store.getState().addDevice('linux-pc', 250, 250);
    const pc2 = store.getState().addDevice('linux-pc', 600, 250);
    const i1 = store.getState().deviceInstances.get(pc1.id) as Record<string, unknown>;
    const i2 = store.getState().deviceInstances.get(pc2.id) as Record<string, unknown>;
    const e1 = i1.executeCommand as (c: string) => Promise<string> | string;
    const e2 = i2.executeCommand as (c: string) => Promise<string> | string;
    await Promise.resolve(e1.call(i1, 'ifconfig eth0 10.0.0.1 netmask 255.255.255.0'));
    await Promise.resolve(e2.call(i2, 'ifconfig eth0 10.0.0.2 netmask 255.255.255.0'));
    store.getState().addConnection(pc1.id, 'eth0', pc2.id, 'eth0', 'ethernet');
    return { pc1: pc1.id, pc2: pc2.id };
  });
}

async function runOn(page: Page, id: string, command: string): Promise<void> {
  await page.evaluate(async ({ id, command }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
    const dev = store.getState().deviceInstances.get(id) as Record<string, unknown>;
    const e = dev.executeCommand as (c: string) => Promise<string> | string;
    await Promise.resolve(e.call(dev, command));
  }, { id, command });
}

test.beforeEach(async ({ page }) => { await page.goto('/'); await waitForStore(page); });

test('shows version with --version', async ({ page }) => {
  const id = await addDevice(page, 'linux-pc');
  await openTerminal(page, id);
  await typeCmd(page, 'tcpdump --version');
  expect((await modalText(page)).toLowerCase()).toContain('tcpdump version');
});

test('prints usage with --help', async ({ page }) => {
  const id = await addDevice(page, 'linux-pc');
  await openTerminal(page, id);
  await typeCmd(page, 'tcpdump --help');
  expect(await modalText(page)).toContain('Usage: tcpdump');
});

test('lists capture interfaces with -D', async ({ page }) => {
  const id = await addDevice(page, 'linux-pc');
  await openTerminal(page, id);
  await typeCmd(page, 'tcpdump -D');
  const text = await modalText(page);
  expect(text).toContain('eth0');
  expect(text).toContain('lo');
});

test('-c 0 prints the banner and an empty capture summary', async ({ page }) => {
  const id = await addDevice(page, 'linux-pc');
  await openTerminal(page, id);
  await typeCmd(page, 'tcpdump -c 0');
  const text = await modalText(page);
  expect(text).toContain('listening on eth0');
  expect(text).toContain('0 packets captured');
});

test('rejects an out-of-range port filter', async ({ page }) => {
  const id = await addDevice(page, 'linux-pc');
  await openTerminal(page, id);
  await typeCmd(page, 'tcpdump port 70000');
  expect((await modalText(page)).toLowerCase()).toMatch(/error|invalid|range/);
});

test('captures a live ICMP echo from a peer and stops on -c 1', async ({ page }) => {
  const { pc1, pc2 } = await lan(page);
  await openTerminal(page, pc1);
  await typeCmd(page, 'tcpdump -c 1 icmp');
  await waitForText(page, 'listening on eth0');
  await runOn(page, pc2, 'ping -c 1 10.0.0.1');
  await waitForText(page, 'ICMP');
  await waitForText(page, '1 packet captured');
});

test('streams an injected TCP segment and prints the summary on -c 1', async ({ page }) => {
  const id = await addDevice(page, 'linux-pc');
  await openTerminal(page, id);
  await typeCmd(page, 'tcpdump -c 1');
  await waitForText(page, 'listening on eth0');
  await page.evaluate((devId) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
    const dev = store.getState().deviceInstances.get(devId) as { executor: { captureLog: { capture(p: object): void } } };
    dev.executor.captureLog.capture({ at: new Date(), srcIp: '10.0.0.1', srcPort: 4444, dstIp: '10.0.0.2', dstPort: 80, flags: 'S', seq: 0, ack: 0, length: 0 });
  }, id);
  await waitForText(page, '10.0.0.1.4444 > 10.0.0.2.80');
  await waitForText(page, '1 packet captured');
});

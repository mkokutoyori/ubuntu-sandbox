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

test.describe('radvd : un routeur Linux annonce un préfixe, l\'hôte se configure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('apt install radvd, radvd.conf, systemctl start : SLAAC, route par défaut et préférence', async ({ page }) => {
    test.slow();
    const router = await addDevice(page, 'linux-server', 360, 260);
    const host = await addDevice(page, 'linux-pc', 120, 260);
    await cable(page, router, 0, host, 0);

    await openTerminal(page, router);
    expect(await output(page, 'radvd -v')).toContain('command not found');
    await typeCmd(page, 'sudo apt install -y radvd', 3000);
    expect(await output(page, 'radvd -v')).toContain('Version: 2.19');
    await typeCmd(page, 'sudo sysctl -w net.ipv6.conf.all.forwarding=1');
    await typeCmd(page, `sudo sh -c 'printf "interface eth0 {\\n AdvSendAdvert on;\\n AdvDefaultPreference high;\\n prefix 2001:db8:77::/64 { };\\n};\\n" > /etc/radvd.conf'`);
    expect(await output(page, 'sudo radvd -c')).toContain('config file, /etc/radvd.conf, syntax ok');
    await typeCmd(page, 'sudo systemctl start radvd', 1500);
    expect(await output(page, 'systemctl is-active radvd')).toContain('active');
    await closeTerminal(page);

    await openTerminal(page, host);
    expect(await output(page, 'ip -6 addr show eth0', 800)).toMatch(/inet6 2001:db8:77:[0-9a-f:]+\/64 scope global/);
    const routes = await output(page, 'ip -6 route show', 800);
    expect(routes).toMatch(/default via fe80::\S+ dev eth0 proto ra metric 1024 expires \d+sec pref high/);
    expect(routes).toMatch(/2001:db8:77::\/64 dev eth0 proto ra metric 256 expires \d+sec pref medium/);
    await closeTerminal(page);

    await openTerminal(page, router);
    await typeCmd(page, 'sudo systemctl stop radvd', 1500);
    await closeTerminal(page);
    await openTerminal(page, host);
    expect(await output(page, 'ip -6 route show', 800)).not.toMatch(/^default/m);
  });
});

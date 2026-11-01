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

async function output(page: Page, command: string): Promise<string> {
  await typeCmd(page, 'clear');
  await typeCmd(page, command);
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

test.describe('une machine Linux dit la même chose partout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('identifiant de démarrage : /proc, systemd-id128 et hostnamectl concordent, uuid change à chaque lecture', async ({ page }) => {
    test.slow();
    await openTerminal(page, await addDevice(page, 'linux-pc', 340, 260));

    const proc = /([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/.exec(await output(page, 'cat /proc/sys/kernel/random/boot_id'))?.[1];
    expect(proc).toBeDefined();
    const bare = proc!.replace(/-/g, '');
    expect(await output(page, 'systemd-id128 boot-id')).toContain(bare);
    expect(await output(page, 'hostnamectl')).toContain(`Boot ID: ${bare}`);

    const first = /([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/.exec(await output(page, 'cat /proc/sys/kernel/random/uuid'))?.[1];
    const second = /([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/.exec(await output(page, 'cat /proc/sys/kernel/random/uuid'))?.[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  test('IPv6 : réglages par interface et ip -6 route get', async ({ page }) => {
    test.slow();
    await openTerminal(page, await addDevice(page, 'linux-pc', 340, 260));

    expect(await output(page, 'cat /proc/sys/net/ipv6/conf/eth0/use_tempaddr')).toContain('2');
    expect(await output(page, 'cat /proc/sys/net/ipv6/conf/lo/use_tempaddr')).toContain('-1');
    expect(await output(page, 'ip -6 route get ::1')).toContain('local ::1 from :: dev lo table local proto kernel src ::1 metric 0 pref medium');
    expect(await output(page, 'ip -6 route get 2001:db8::1')).toContain('RTNETLINK answers: Network is unreachable');
  });
});

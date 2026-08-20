import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addDevice(page: Page, type: string, x = 400, y = 300): Promise<string> {
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

async function publishOspfAdjChange(page: Page, id: string, oldState: string, newState: string, event = 'HelloReceived'): Promise<void> {
  await page.evaluate(({ id, oldState, newState, event }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
    const dev = store.getState().deviceInstances.get(id) as { getBus(): { publish(e: unknown): void } };
    dev.getBus().publish({
      topic: 'ospf.neighbor.state-changed',
      payload: {
        routerId: '1.1.1.1',
        processId: 1,
        deviceId: id,
        iface: 'GigabitEthernet0/0/0',
        neighborId: '2.2.2.2',
        oldState, newState, event,
      },
    });
  }, { id, oldState, newState, event });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.afterEach(async ({ page }) => { await closeTerminal(page); });

test.describe('Huawei VRP — terminal debugging through the real UI', () => {
  test('debugging ospf event + terminal debugging streams a VRP-format neighbor line', async ({ page }) => {
    const id = await addDevice(page, 'router-huawei');
    await openTerminal(page, id);

    await typeCmd(page, 'debugging ospf event');
    await typeCmd(page, 'terminal debugging');
    await waitForText(page, 'Current terminal debugging is on');

    await publishOspfAdjChange(page, id, 'Init', '2WAY');
    await waitForText(page, /OSPF: Neighbor \(2\.2\.2\.2\) state change: Init -> 2WAY \(HelloReceived\) on GigabitEthernet0\/0\/0/, 4_000);
  });

  test('terminal debugging without a debug flag stays silent', async ({ page }) => {
    const id = await addDevice(page, 'router-huawei');
    await openTerminal(page, id);

    await typeCmd(page, 'terminal debugging');
    await waitForText(page, 'Current terminal debugging is on');

    await publishOspfAdjChange(page, id, 'Init', '2WAY');
    await page.waitForTimeout(400);
    expect(await modalText(page)).not.toContain('OSPF: Neighbor');
  });

  test('undo terminal debugging stops the stream — further events are silent', async ({ page }) => {
    const id = await addDevice(page, 'router-huawei');
    await openTerminal(page, id);

    await typeCmd(page, 'debugging ospf event');
    await typeCmd(page, 'terminal debugging');
    await publishOspfAdjChange(page, id, 'Init', '2WAY');
    await waitForText(page, /OSPF: Neighbor \(2\.2\.2\.2\)/, 4_000);

    const before = (await modalText(page)).match(/OSPF: Neighbor \(2\.2\.2\.2\)/g)?.length ?? 0;
    await typeCmd(page, 'undo terminal debugging');
    await waitForText(page, 'Current terminal debugging is off');

    await publishOspfAdjChange(page, id, '2WAY', 'Full', 'AdjOK?');
    await page.waitForTimeout(500);
    const after = (await modalText(page)).match(/OSPF: Neighbor \(2\.2\.2\.2\)/g)?.length ?? 0;
    expect(after).toBe(before);
  });

  test('undo debugging all cancels the subscription', async ({ page }) => {
    const id = await addDevice(page, 'router-huawei');
    await openTerminal(page, id);

    await typeCmd(page, 'debugging ospf event');
    await typeCmd(page, 'terminal debugging');
    await publishOspfAdjChange(page, id, 'Init', '2WAY');
    await waitForText(page, /OSPF: Neighbor/, 4_000);

    await typeCmd(page, 'undo debugging all');
    const baseline = (await modalText(page)).match(/OSPF: Neighbor/g)?.length ?? 0;

    await publishOspfAdjChange(page, id, '2WAY', 'Full', 'AdjOK?');
    await page.waitForTimeout(500);
    const after = (await modalText(page)).match(/OSPF: Neighbor/g)?.length ?? 0;
    expect(after).toBe(baseline);
  });

  test('display debugging shows the enabled flag', async ({ page }) => {
    const id = await addDevice(page, 'router-huawei');
    await openTerminal(page, id);

    await typeCmd(page, 'debugging ospf event');
    await typeCmd(page, 'display debugging');
    await waitForText(page, 'OSPF event debugging is on');
  });
});

test.describe('Huawei VRP — terminal monitor through the real UI', () => {
  test('terminal monitor streams a syslog line on a bus event', async ({ page }) => {
    const id = await addDevice(page, 'router-huawei');
    await openTerminal(page, id);

    await typeCmd(page, 'terminal monitor');
    await waitForText(page, 'Current terminal monitor is on');

    await publishOspfAdjChange(page, id, 'Loading', 'Full', 'LoadingDone');
    await waitForText(page, /%OSPF-5-NOTIFICATIONS: Process 1, Nbr 2\.2\.2\.2 on GigabitEthernet0\/0\/0 from Loading to Full, LoadingDone/, 4_000);
  });

  test('undo terminal monitor stops the syslog stream', async ({ page }) => {
    const id = await addDevice(page, 'router-huawei');
    await openTerminal(page, id);

    await typeCmd(page, 'terminal monitor');
    await publishOspfAdjChange(page, id, 'Loading', 'Full', 'LoadingDone');
    await waitForText(page, /Nbr 2\.2\.2\.2/, 4_000);
    const before = (await modalText(page)).match(/Nbr 2\.2\.2\.2/g)?.length ?? 0;

    await typeCmd(page, 'undo terminal monitor');
    await waitForText(page, 'Current terminal monitor is off');

    await publishOspfAdjChange(page, id, 'Init', '2WAY');
    await page.waitForTimeout(500);
    const after = (await modalText(page)).match(/Nbr 2\.2\.2\.2/g)?.length ?? 0;
    expect(after).toBe(before);
  });

  test('terminal debugging and terminal monitor work independently', async ({ page }) => {
    const id = await addDevice(page, 'router-huawei');
    await openTerminal(page, id);

    await typeCmd(page, 'terminal monitor');
    await typeCmd(page, 'debugging ospf event');
    await typeCmd(page, 'terminal debugging');

    await publishOspfAdjChange(page, id, 'Init', '2WAY');
    await waitForText(page, /OSPF: Neighbor \(2\.2\.2\.2\)/, 4_000);
    await waitForText(page, /Nbr 2\.2\.2\.2/, 4_000);

    await typeCmd(page, 'undo terminal debugging');
    await waitForText(page, 'Current terminal debugging is off');
    const debugBefore = (await modalText(page)).match(/OSPF: Neighbor/g)?.length ?? 0;
    const monitorBefore = (await modalText(page)).match(/Nbr 2\.2\.2\.2/g)?.length ?? 0;

    await publishOspfAdjChange(page, id, '2WAY', 'Full', 'AdjOK?');
    await page.waitForTimeout(500);
    const text = await modalText(page);
    const debugAfter = text.match(/OSPF: Neighbor/g)?.length ?? 0;
    const monitorAfter = text.match(/Nbr 2\.2\.2\.2/g)?.length ?? 0;
    expect(debugAfter).toBe(debugBefore);
    expect(monitorAfter).toBeGreaterThan(monitorBefore);
  });
});

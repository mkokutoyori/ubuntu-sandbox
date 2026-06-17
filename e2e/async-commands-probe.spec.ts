/**
 * Diagnostic probe (not a pass/fail suite): drives ping -t, reload in, and
 * debug through the real browser UI and records what actually happens, so we
 * can enumerate the gaps in the async-command emulation.
 */
import { test, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';

mkdirSync('/tmp/probe', { recursive: true });
const findings: Record<string, unknown>[] = [];
function record(entry: Record<string, unknown>): void {
  findings.push(entry);
  console.log('PROBE', JSON.stringify(entry));
}

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
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

async function closeTerminal(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function visibleTextInputs(page: Page): Promise<number> {
  return page.locator('[data-testid="terminal-modal"] input[type="text"]:visible').count();
}

async function infoBarText(page: Page): Promise<string> {
  const bar = page.locator('[data-testid="terminal-modal"]').locator('text=/background|debug output/i');
  return (await bar.count()) > 0 ? (await bar.first().innerText()).trim() : '';
}

async function ctrlC(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"]').click();
  await page.keyboard.press('Control+C');
}

async function lan(page: Page, leftType: string): Promise<{ left: string; right: string }> {
  return page.evaluate(async ({ leftType }) => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const left = store.getState().addDevice(leftType, 250, 250);
    const right = store.getState().addDevice('linux-pc', 600, 250);
    const li = store.getState().deviceInstances.get(left.id) as Record<string, unknown>;
    const ri = store.getState().deviceInstances.get(right.id) as Record<string, unknown>;
    const lp = (li.getPortNames as () => string[])().find((n) => n.startsWith('eth') || n.startsWith('Ethernet')) ?? (li.getPortNames as () => string[])()[0];
    const rp = (ri.getPortNames as () => string[])().find((n) => n.startsWith('eth')) ?? (ri.getPortNames as () => string[])()[0];
    const e1 = li.executeCommand as ((c: string) => Promise<string> | string) | undefined;
    const e2 = ri.executeCommand as ((c: string) => Promise<string> | string) | undefined;
    if (leftType === 'linux-pc' && e1) await Promise.resolve(e1.call(li, `sudo ip addr add 192.168.1.10/24 dev ${lp}`));
    if (e2) await Promise.resolve(e2.call(ri, `sudo ip addr add 192.168.1.20/24 dev ${rp}`));
    store.getState().addConnection(left.id, lp, right.id, rp, 'ethernet');
    return { left: left.id, right: right.id };
  }, { leftType });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test('probe: windows ping -t (continuous)', async ({ page }) => {
  const { left } = await lan(page, 'windows-pc');
  // give the windows host an IP via its own shell
  await page.evaluate(({ id }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
    const dev = store.getState().deviceInstances.get(id) as Record<string, unknown>;
    const e = dev.executeCommand as ((c: string) => Promise<string> | string) | undefined;
    return e ? Promise.resolve(e.call(dev, 'netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0')) : null;
  }, { id: left });

  await openTerminal(page, left);
  await typeCmd(page, 'ping -t 192.168.1.20');
  await page.waitForTimeout(1500);
  const t1 = await modalText(page);
  await page.waitForTimeout(1800);
  const t2 = await modalText(page);
  const lockedDuring = await visibleTextInputs(page);
  await page.screenshot({ path: '/tmp/probe/win-ping-t-running.png' });
  await ctrlC(page);
  await page.waitForTimeout(1200);
  const t3 = await modalText(page);
  await page.screenshot({ path: '/tmp/probe/win-ping-t-afterctrlc.png' });

  record({
    probe: 'windows ping -t',
    grewProgressively: t2.length > t1.length,
    linesT1: t1.split('\n').length, linesT2: t2.split('\n').length,
    visibleInputsWhileRunning: lockedDuring,
    stoppedAfterCtrlC: t3.split('\n').length <= t2.split('\n').length + 2,
    hasStatistics: /statistics|packets|lost|loss/i.test(t3),
    tailAfterCtrlC: t3.split('\n').slice(-6),
  });
});

test('probe: cisco reload in', async ({ page }) => {
  const id = await addDevice(page, 'router-cisco', 400, 300);
  await openTerminal(page, id);
  await typeCmd(page, 'enable');
  await page.waitForTimeout(500);
  await typeCmd(page, 'reload in 1');
  await page.waitForTimeout(1200);
  const text = await modalText(page);
  await page.screenshot({ path: '/tmp/probe/cisco-reload-in.png' });
  record({
    probe: 'cisco reload in 1',
    output: text.split('\n').slice(-8),
    looksScheduled: /reload|scheduled|SHUTDOWN|proceed/i.test(text),
    looksUnknown: /invalid|incomplete|unrecognized|\^/i.test(text),
  });
});

test('probe: cisco debug ip ospf', async ({ page }) => {
  const id = await addDevice(page, 'router-cisco', 400, 300);
  await openTerminal(page, id);
  for (const c of ['enable', 'configure terminal', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'end']) {
    await typeCmd(page, c); await page.waitForTimeout(300);
  }
  await typeCmd(page, 'debug ip ospf adj');
  await page.waitForTimeout(1000);
  const indicator = await infoBarText(page);
  const inputsAfter = await visibleTextInputs(page);
  const text = await modalText(page);
  await page.screenshot({ path: '/tmp/probe/cisco-debug-ospf.png' });
  record({
    probe: 'cisco debug ip ospf adj',
    debugAck: /debugging is on/i.test(text),
    backgroundIndicator: indicator,
    promptStaysFree: inputsAfter > 0,
    output: text.split('\n').slice(-6),
  });
});

test('probe: cisco switch debug spanning-tree', async ({ page }) => {
  const id = await addDevice(page, 'switch-cisco', 400, 300);
  await openTerminal(page, id);
  await typeCmd(page, 'enable');
  await page.waitForTimeout(400);
  await typeCmd(page, 'debug spanning-tree events');
  await page.waitForTimeout(1000);
  const indicator = await infoBarText(page);
  const inputsAfter = await visibleTextInputs(page);
  const text = await modalText(page);
  await page.screenshot({ path: '/tmp/probe/cisco-switch-debug-stp.png' });
  record({
    probe: 'cisco switch debug spanning-tree events',
    debugAck: /debugging is on/i.test(text),
    backgroundIndicator: indicator,
    promptStaysFree: inputsAfter > 0,
    output: text.split('\n').slice(-6),
  });
});

test('probe: linux ping streaming (sanity)', async ({ page }) => {
  const { left } = await lan(page, 'linux-pc');
  await openTerminal(page, left);
  await typeCmd(page, 'ping -c 3 -i 0.3 192.168.1.20');
  await page.waitForTimeout(700);
  const t1 = await modalText(page);
  const inputsDuring = await visibleTextInputs(page);
  await page.waitForTimeout(2200);
  const t2 = await modalText(page);
  await page.screenshot({ path: '/tmp/probe/linux-ping.png' });
  record({
    probe: 'linux ping -c 3 (sanity)',
    grewProgressively: t2.length > t1.length,
    visibleInputsWhileRunning: inputsDuring,
    hasStatistics: /ping statistics/i.test(t2),
    tail: t2.split('\n').slice(-6),
  });
});

test('probe: linux watch (real-time refresh)', async ({ page }) => {
  const id = await addDevice(page, 'linux-pc', 400, 300);
  await openTerminal(page, id);
  await typeCmd(page, 'watch -n 0.5 date');
  await page.waitForTimeout(800);
  const t1 = await modalText(page);
  const inputsDuring = await visibleTextInputs(page);
  await page.waitForTimeout(1600);
  const t2 = await modalText(page);
  await ctrlC(page);
  await page.waitForTimeout(400);
  const t3 = await modalText(page);
  await page.screenshot({ path: '/tmp/probe/linux-watch.png' });
  record({
    probe: 'linux watch',
    hasHeader: /Every 0\.5s: date/.test(t2),
    promptLockedWhileRunning: inputsDuring === 0,
    refreshedInPlace: Math.abs(t2.split('\n').length - t1.split('\n').length) <= 2,
    stoppedAfterCtrlC: t3.includes('^C'),
  });
});

test.afterAll(() => {
  writeFileSync('/tmp/probe/report.json', JSON.stringify(findings, null, 2));
});

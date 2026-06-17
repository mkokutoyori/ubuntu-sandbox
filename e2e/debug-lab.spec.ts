/**
 * Debug lab — verifies that live debug output (STP, OSPF) actually streams
 * into the terminal of a running topology, driven through the real UI.
 */
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';

mkdirSync('/tmp/probe', { recursive: true });
const findings: Record<string, unknown>[] = [];
function record(e: Record<string, unknown>): void { findings.push(e); console.log('LAB', JSON.stringify(e)); }

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

type StoreShape = {
  addDevice(t: string, x: number, y: number): { id: string };
  deviceInstances: Map<string, Record<string, unknown>>;
  addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
};

async function build(page: Page, leftType: string, rightType: string, leftCfg: string[], rightCfg: string[]): Promise<{ left: string }> {
  return page.evaluate(async ({ leftType, rightType, leftCfg, rightCfg }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreShape };
    const run = async (dev: Record<string, unknown>, cmds: string[]) => {
      const e = dev.executeCommand as ((c: string) => Promise<string> | string) | undefined;
      if (e) for (const c of cmds) await Promise.resolve(e.call(dev, c));
    };
    const L = store.getState().addDevice(leftType, 250, 250);
    const R = store.getState().addDevice(rightType, 600, 250);
    const li = store.getState().deviceInstances.get(L.id) as Record<string, unknown>;
    const ri = store.getState().deviceInstances.get(R.id) as Record<string, unknown>;
    const lp = (li.getPortNames as () => string[])()[0];
    const rp = (ri.getPortNames as () => string[])()[0];
    await run(li, leftCfg);
    await run(ri, rightCfg);
    store.getState().addConnection(L.id, lp, R.id, rp, 'ethernet');
    return { left: L.id };
  }, { leftType, rightType, leftCfg, rightCfg } as unknown as Record<string, never>) as Promise<{ left: string }>;
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
  await page.waitForTimeout(350);
}
async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}
async function waitForLine(page: Page, re: RegExp, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (re.test(await modalText(page))) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

test.beforeEach(async ({ page }) => { await page.goto('/'); await waitForStore(page); });

test('STP lab: debug spanning-tree streams live BPDU/role events', async ({ page }) => {
  const { left } = await build(page, 'switch-cisco', 'switch-cisco', [], []);
  await openTerminal(page, left);
  await typeCmd(page, 'enable');
  await typeCmd(page, 'debug spanning-tree');

  const indicator = (await page.locator('[data-testid="terminal-modal"]').locator('text=/background|debug output/i').count()) > 0;
  const sawStp = await waitForLine(page, /STP:/, 12_000);
  const text = await modalText(page);
  await page.screenshot({ path: '/tmp/probe/lab-stp.png' });
  record({ lab: 'STP', indicatorPresent: indicator, sawDebugLine: sawStp, tail: text.split('\n').slice(-8) });
  expect(sawStp).toBe(true);
});

test('OSPF lab: debug ip ospf streams live packet/adjacency events', async ({ page }) => {
  test.setTimeout(60_000);
  const r1Cfg = [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
    'ip ospf hello-interval 1', 'ip ospf dead-interval 4', 'no shutdown', 'exit',
    'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'end',
  ];
  const r2Cfg = [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0',
    'ip ospf hello-interval 1', 'ip ospf dead-interval 4', 'no shutdown', 'exit',
    'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'end',
  ];
  const { left } = await build(page, 'router-cisco', 'router-cisco', r1Cfg, r2Cfg);
  await openTerminal(page, left);
  await typeCmd(page, 'enable');
  await typeCmd(page, 'debug ip ospf adj');
  await typeCmd(page, 'debug ip ospf packet');

  const sawOspf = await waitForLine(page, /OSPF[:-]/, 40_000);
  const text = await modalText(page);
  await page.screenshot({ path: '/tmp/probe/lab-ospf.png' });
  record({ lab: 'OSPF', sawDebugLine: sawOspf, sawAdjChg: /ADJCHG/.test(text), tail: text.split('\n').slice(-10) });
  expect(sawOspf).toBe(true);
});

test.afterAll(() => { writeFileSync('/tmp/probe/lab-report.json', JSON.stringify(findings, null, 2)); });

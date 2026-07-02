/**
 * l3-switch-tutorial-screenshots — capture every figure used by
 * `docs/tutoriel-l3-switch.md`. The spec drives the real UI through
 * Playwright: build a Huawei L3 switch lab (2 PCs in different VLANs
 * + a Vlanif per VLAN as their gateway), exercise inter-VLAN routing
 * and the integrated DHCP server, screenshot each milestone. Each
 * shot is preceded by an assertion on the terminal text so the figures
 * cannot drift silently if the UI or the L3 engine regresses.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';

const OUT = 'docs/images/l3-switch';
mkdirSync(OUT, { recursive: true });

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 20_000 },
  );
}

interface Lab { sw: string; pc1: string; pc2: string }

async function buildLab(page: Page): Promise<Lab> {
  return page.evaluate(async () => {
    type Dev = Record<string, unknown>;
    type StoreState = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Dev>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const add = (t: string, x: number, y: number) => store.getState().addDevice(t, x, y).id;
    const inst = (id: string) => store.getState().deviceInstances.get(id) as Dev;
    const exec = async (id: string, cmd: string) => {
      const fn = inst(id).executeCommand as ((c: string) => Promise<string> | string) | undefined;
      if (fn) await Promise.resolve(fn.call(inst(id), cmd));
    };

    const sw  = add('switch-huawei', 460, 140);
    const pc1 = add('linux-pc', 220, 420);
    const pc2 = add('linux-pc', 700, 420);

    const swInst = inst(sw);
    const swPorts = (swInst.getPortNames as () => string[])();
    const pc1Port = ((inst(pc1).getPortNames as () => string[])().find(n => n.startsWith('eth'))) ?? 'eth0';
    const pc2Port = ((inst(pc2).getPortNames as () => string[])().find(n => n.startsWith('eth'))) ?? 'eth0';

    store.getState().addConnection(pc1, pc1Port, sw, swPorts[0], 'ethernet');
    store.getState().addConnection(pc2, pc2Port, sw, swPorts[1], 'ethernet');

    // Configure the switch as a true L3 device + integrated DHCP server
    // for VLAN 10. PC1 will pull DHCP; PC2 has a static IP in VLAN 20 so
    // both inter-VLAN routing AND DHCP get demoed in the same lab.
    for (const cmd of [
      'system-view',
      'sysname CORE-SW',
      'dhcp enable',
      'vlan batch 10 20',
      'interface GigabitEthernet0/0/0', 'port link-type access', 'port default vlan 10', 'quit',
      'interface GigabitEthernet0/0/1', 'port link-type access', 'port default vlan 20', 'quit',
      'interface Vlanif10',
      'ip address 10.0.10.1 255.255.255.0', 'undo shutdown',
      'dhcp select global', 'quit',
      'interface Vlanif20',
      'ip address 10.0.20.1 255.255.255.0', 'undo shutdown', 'quit',
      'ip pool VLAN10',
      'network 10.0.10.0 mask 255.255.255.0',
      'gateway-list 10.0.10.1',
      'dns-list 8.8.8.8',
      'excluded-ip-address 10.0.10.1 10.0.10.99',
      'lease day 1', 'quit',
      'quit',
    ]) await exec(sw, cmd);

    // PC2 gets a static IP in VLAN 20 via the standard Linux net stack
    // (the simulator parses `ifconfig` / `ip route` like any host).
    // PC1 will fetch its lease later via dhclient.
    await exec(pc2, `ifconfig ${pc2Port} 10.0.20.100 netmask 255.255.255.0`);
    await exec(pc2, 'ip route add default via 10.0.20.1');

    return { sw, pc1, pc2 };
  });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(400);
}

async function closeTerminal(page: Page): Promise<void> {
  const modal = page.locator('[data-testid="terminal-modal"]');
  const closeBtn = modal.locator('button[title="Close"]').first();
  if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
  await modal.waitFor({ state: 'hidden', timeout: 5_000 });
}

async function typeCmd(page: Page, command: string, settleMs = 350): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(settleMs);
}

async function termText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

test.describe('L3 switch tutorial — screenshots', () => {
  test('Huawei L3 switch end-to-end — every figure for the tutorial', async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto('/');
    await waitForStore(page);
    const lab = await buildLab(page);
    await page.waitForTimeout(800);

    // Figure 1 — topology canvas (switch + 2 PCs).
    await page.screenshot({ path: `${OUT}/01-topologie.png`, fullPage: false });

    // Figure 2 — switch shows the L3 routing table (Vlanif10/20 direct).
    await openTerminal(page, lab.sw);
    await typeCmd(page, 'display ip routing-table', 500);
    await expect(page.locator('[data-testid="terminal-modal"]')
      .getByText('Vlanif10', { exact: false })).toBeVisible({ timeout: 6_000 });
    await page.screenshot({ path: `${OUT}/02-routing-table.png`, fullPage: false });

    // Figure 3 — display ip interface brief lists both Vlanif up/up.
    await typeCmd(page, 'display ip interface brief', 500);
    await expect(page.locator('[data-testid="terminal-modal"]')
      .getByText(/Vlanif20.*10\.0\.20\.1/)).toBeVisible({ timeout: 6_000 });
    await page.screenshot({ path: `${OUT}/03-interface-brief.png`, fullPage: false });
    await closeTerminal(page);

    // Figure 4 — PC1 obtains a DHCP lease from the L3 switch.
    await openTerminal(page, lab.pc1);
    await typeCmd(page, 'dhclient -v eth0', 1500);
    await expect(page.locator('[data-testid="terminal-modal"]')
      .getByText(/DHCPACK of 10\.0\.10\./)).toBeVisible({ timeout: 8_000 });
    await page.screenshot({ path: `${OUT}/04-pc1-dhclient.png`, fullPage: false });
    await closeTerminal(page);

    // Figure 5 — PC1 (DHCP in VLAN 10) pings PC2 static in VLAN 20.
    await openTerminal(page, lab.pc1);
    await typeCmd(page, 'ping -c 3 10.0.20.100', 1500);
    const pingOut = await termText(page);
    expect(pingOut).toMatch(/64 bytes from 10\.0\.20\.100/);
    await page.screenshot({ path: `${OUT}/05-inter-vlan-ping.png`, fullPage: false });
    await closeTerminal(page);

    // Figure 6 — switch's ARP cache learned both PCs.
    await openTerminal(page, lab.sw);
    await typeCmd(page, 'display arp', 500);
    await expect(page.locator('[data-testid="terminal-modal"]')
      .getByText(/10\.0\.10\.100/)).toBeVisible({ timeout: 6_000 });
    await page.screenshot({ path: `${OUT}/06-display-arp.png`, fullPage: false });
    await closeTerminal(page);
  });
});

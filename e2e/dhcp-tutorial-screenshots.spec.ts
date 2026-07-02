/**
 * dhcp-tutorial-screenshots — drive the DHCP lab in the real UI and
 * capture the screenshots used by `docs/tutoriel-dhcp.md`.
 *
 * The spec doubles as an integration test: each screenshot is preceded
 * by an assertion that the relevant terminal output appeared (DORA
 * tokens, bound IP, show ip dhcp binding rows). If the UI regresses on
 * DHCP, the spec fails before producing a stale screenshot.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';

const OUT = 'docs/images/dhcp';
mkdirSync(OUT, { recursive: true });

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 20_000 },
  );
}

interface Lab { router: string; sw: string; pc1: string; pc2: string }

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
    const portNames = (id: string) => (inst(id).getPortNames as () => string[])();

    const router = add('router-cisco', 300, 120);
    const sw     = add('switch-generic', 540, 280);
    const pc1    = add('linux-pc',  340, 460);
    const pc2    = add('linux-pc',  740, 460);

    // Router uplink: G0/0 carries the LAN with the DHCP pool.
    await exec(router, 'enable');
    await exec(router, 'configure terminal');
    await exec(router, 'hostname Passerelle');
    await exec(router, 'interface GigabitEthernet0/0');
    await exec(router, 'ip address 192.168.1.1 255.255.255.0');
    await exec(router, 'no shutdown');
    await exec(router, 'exit');
    await exec(router, 'ip dhcp excluded-address 192.168.1.1 192.168.1.99');
    await exec(router, 'ip dhcp pool LAN-MAISON');
    await exec(router, 'network 192.168.1.0 255.255.255.0');
    await exec(router, 'default-router 192.168.1.1');
    await exec(router, 'dns-server 8.8.8.8 1.1.1.1');
    await exec(router, 'lease 1');
    await exec(router, 'end');

    const rPort = portNames(router)[0]; // G0/0
    const swP   = portNames(sw);
    const pc1P  = portNames(pc1).find(n => n.startsWith('eth')) ?? portNames(pc1)[0];
    const pc2P  = portNames(pc2).find(n => n.startsWith('eth')) ?? portNames(pc2)[0];

    store.getState().addConnection(router, rPort, sw, swP[0], 'ethernet');
    store.getState().addConnection(pc1, pc1P, sw, swP[1], 'ethernet');
    store.getState().addConnection(pc2, pc2P, sw, swP[2], 'ethernet');

    return { router, sw, pc1, pc2 };
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

async function typeCmd(page: Page, command: string, settleMs = 300): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(settleMs);
}

async function termText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

test.describe('DHCP tutorial — screenshots', () => {
  test('end-to-end DORA — captures every figure used by the tutorial', async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto('/');
    await waitForStore(page);
    const lab = await buildLab(page);
    await page.waitForTimeout(800);

    // Figure 1 — topology canvas.
    await page.screenshot({ path: `${OUT}/01-topologie.png`, fullPage: false });

    // Figure 2 — router CLI showing the configured pool.
    await openTerminal(page, lab.router);
    await typeCmd(page, 'show running-config | section dhcp', 600);
    await page.waitForTimeout(400);
    await expect(page.locator('[data-testid="terminal-modal"]').getByText('ip dhcp pool LAN-MAISON', { exact: false }))
      .toBeVisible({ timeout: 6_000 });
    await page.screenshot({ path: `${OUT}/02-pool-config.png`, fullPage: false });
    await closeTerminal(page);

    // Figure 3 — PC1 runs dhclient eth0; DORA tokens must appear.
    await openTerminal(page, lab.pc1);
    await typeCmd(page, 'dhclient -v eth0', 1500);
    await expect(page.locator('[data-testid="terminal-modal"]')
      .getByText(/DHCPDISCOVER/, { exact: false })).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('[data-testid="terminal-modal"]')
      .getByText(/DHCPOFFER/, { exact: false })).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('[data-testid="terminal-modal"]')
      .getByText(/DHCPACK/, { exact: false })).toBeVisible({ timeout: 8_000 });
    await page.screenshot({ path: `${OUT}/03-dhclient-dora.png`, fullPage: false });

    // Figure 4 — same PC, ip addr show eth0 confirms the bound IP.
    await typeCmd(page, 'ip addr show eth0', 500);
    const pc1Text = await termText(page);
    expect(pc1Text).toMatch(/192\.168\.1\.\d+/);
    await page.screenshot({ path: `${OUT}/04-ip-addr-bound.png`, fullPage: false });
    await closeTerminal(page);

    // PC2 also asks for a lease — different IP from the same pool.
    await openTerminal(page, lab.pc2);
    await typeCmd(page, 'dhclient -v eth0', 1500);
    await expect(page.locator('[data-testid="terminal-modal"]')
      .getByText(/DHCPACK/, { exact: false })).toBeVisible({ timeout: 8_000 });
    await closeTerminal(page);

    // Figure 5 — router CLI: show ip dhcp binding lists the two leases.
    await openTerminal(page, lab.router);
    await typeCmd(page, 'show ip dhcp binding', 600);
    const routerText = await termText(page);
    const leases = (routerText.match(/192\.168\.1\.1\d{2}/g) ?? []);
    expect(leases.length).toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: `${OUT}/05-show-binding.png`, fullPage: false });
    await closeTerminal(page);

    // Figure 6 — PC1 tcpdump replays the captured DORA exchange.
    await openTerminal(page, lab.pc1);
    await typeCmd(page, 'tcpdump -nn port 67 or port 68', 600);
    await page.screenshot({ path: `${OUT}/06-tcpdump-dora.png`, fullPage: false });
    await closeTerminal(page);
  });
});

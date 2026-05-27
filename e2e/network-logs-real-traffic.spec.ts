/**
 * End-to-end: real network traffic surfaces in the Network Logs panel.
 *
 * The previous logs-panel suite drove `__logger.info(...)` directly,
 * which only proves the React hook + Logger pub/sub work. This spec
 * drives the SIMULATOR (configure IPs, cable two PCs, send a ping)
 * and verifies the resulting ARP and ICMP events flow through to the
 * panel — the actual operator scenario.
 */
import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

async function setupTwoPcLan(page: Page): Promise<void> {
  await page.evaluate(async () => {
    type StoreState = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, b: string, c: string, d: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const pc1 = store.getState().addDevice('linux-pc', 200, 300);
    const pc2 = store.getState().addDevice('linux-pc', 500, 300);
    const inst1 = store.getState().deviceInstances.get(pc1.id) as Record<string, unknown>;
    const inst2 = store.getState().deviceInstances.get(pc2.id) as Record<string, unknown>;
    const p1 = ((inst1.getPortNames as () => string[])()).find((n) => n.startsWith('eth')) ?? 'eth0';
    const p2 = ((inst2.getPortNames as () => string[])()).find((n) => n.startsWith('eth')) ?? 'eth0';
    const exec1 = inst1.executeCommand as ((c: string) => Promise<string> | string);
    const exec2 = inst2.executeCommand as ((c: string) => Promise<string> | string);
    await Promise.resolve(exec1.call(inst1, `sudo ip addr add 10.0.0.1/24 dev ${p1}`));
    await Promise.resolve(exec2.call(inst2, `sudo ip addr add 10.0.0.2/24 dev ${p2}`));
    store.getState().addConnection(pc1.id, p1, pc2.id, p2, 'ethernet');
    // Drive the ping from PC1 → PC2. Result is awaited so the test
    // observes the panel only after the exchange has actually happened.
    await Promise.resolve(exec1.call(inst1, 'ping -c 1 10.0.0.2'));
  });
}

test.describe('Network Logs panel — real simulator traffic', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
    await page.locator('button[title="Logs"]').click();
  });

  test('configuring an IP shows up as host:interface-config', async ({ page }) => {
    await page.evaluate(async () => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): {
          addDevice(t: string, x: number, y: number): { id: string };
          deviceInstances: Map<string, Record<string, unknown>>;
        };
      };
      const pc = store.getState().addDevice('linux-pc', 300, 300);
      const inst = store.getState().deviceInstances.get(pc.id) as Record<string, unknown>;
      const ports = (inst.getPortNames as () => string[])();
      const p = ports.find((n) => n.startsWith('eth')) ?? 'eth0';
      const exec = inst.executeCommand as ((c: string) => Promise<string> | string);
      await Promise.resolve(exec.call(inst, `sudo ip addr add 10.0.0.5/24 dev ${p}`));
    });

    await expect(page.locator('[data-testid="logs-list"]')).toContainText('host:interface-config');
    await expect(page.locator('[data-testid="logs-list"]')).toContainText('10.0.0.5');
  });

  test('a ping between two PCs emits ARP + ICMP events in the panel', async ({ page }) => {
    await setupTwoPcLan(page);

    const list = page.locator('[data-testid="logs-list"]');
    // ARP exchange: requester emits arp:request, responder emits arp:reply.
    await expect(list).toContainText('arp:request');
    await expect(list).toContainText('who-has 10.0.0.2');
    await expect(list).toContainText('arp:reply');
    // ICMP echo: outbound from PC1, reply from PC2.
    await expect(list).toContainText('icmp:echo-sent');
    await expect(list).toContainText('icmp:echo-reply');

    await page.screenshot({ path: 'test-results/logs-real-ping.png', fullPage: true });
  });

  test('clicking an arp:request row reveals its target IP in the detail data', async ({ page }) => {
    await setupTwoPcLan(page);

    // Find the first arp:request row (oldest such row works because
    // the panel renders newest-first so .last() targets it).
    const arpRow = page.locator('[data-testid="logs-row"]', { hasText: 'arp:request' }).first();
    await expect(arpRow).toBeVisible();
    await arpRow.click();

    const detail = page.locator('[data-testid="logs-detail"]');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('"targetIp": "10.0.0.2"');
  });
});

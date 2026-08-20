/**
 * Incident registry E2E — Playwright (docs/PRD-Pannes.md §25, Phase 1).
 *
 * The e2e counterpart of
 * src/__tests__/unit/network-v2/faults/fault-{registry,projection}.test.ts.
 * Where those drive the model directly, this drives the real application:
 * the app boots, wires its own projection, and the faults appear because
 * the operator pulled a cable or hit the power button — not because a test
 * called `raise()`.
 *
 * What that catches which the unit tests cannot: the projection actually
 * being attached at startup (main.tsx), surviving a real browser page, and
 * seeing the events the real store emits rather than a hand-built lab.
 */

import { test, expect, type Page } from '@playwright/test';

interface FaultView {
  id: string;
  code: string;
  severity: string;
  deviceId: string;
  scope: string;
  summary: string;
  remedy?: string;
  investigate?: string;
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore
      && !!(window as Record<string, unknown>).__faults,
    { timeout: 15_000 },
  );
}

/** PC1 (192.168.1.10/24) and SRV1 (192.168.1.20/24), directly cabled. */
async function setupLan(page: Page): Promise<{ pcId: string; srvId: string }> {
  return page.evaluate(async () => {
    type StoreState = {
      addDevice(type: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };

    const pcDto = store.getState().addDevice('linux-pc', 300, 300);
    const srvDto = store.getState().addDevice('linux-server', 600, 300);
    const pc = store.getState().deviceInstances.get(pcDto.id) as Record<string, unknown>;
    const srv = store.getState().deviceInstances.get(srvDto.id) as Record<string, unknown>;

    const pcPort = (pc.getPortNames as () => string[])().find(n => n.startsWith('eth'))!;
    const srvPort = (srv.getPortNames as () => string[])().find(n => n.startsWith('eth'))!;

    const run = (d: Record<string, unknown>, cmd: string) =>
      Promise.resolve((d.executeCommand as (c: string) => unknown)?.call(d, cmd));
    await run(pc, `sudo ip addr add 192.168.1.10/24 dev ${pcPort}`);
    await run(srv, `sudo ip addr add 192.168.1.20/24 dev ${srvPort}`);

    store.getState().addConnection(pcDto.id, pcPort, srvDto.id, srvPort, 'ethernet');
    return { pcId: pcDto.id, srvId: srvDto.id };
  });
}

async function faultsFor(page: Page, deviceId: string): Promise<FaultView[]> {
  return page.evaluate((id) => {
    const reg = (window as Record<string, unknown>).__faults as {
      forDevice(d: string): FaultView[];
    };
    return JSON.parse(JSON.stringify(reg.forDevice(id))) as FaultView[];
  }, deviceId);
}

async function allFaults(page: Page): Promise<FaultView[]> {
  return page.evaluate(() => {
    const reg = (window as Record<string, unknown>).__faults as { list(): FaultView[] };
    return JSON.parse(JSON.stringify(reg.list())) as FaultView[];
  });
}

async function groupedFaults(page: Page): Promise<{ root: FaultView; consequences: FaultView[] }[]> {
  return page.evaluate(() => {
    const reg = (window as Record<string, unknown>).__faults as {
      grouped(): { root: FaultView; consequences: FaultView[] }[];
    };
    return JSON.parse(JSON.stringify(reg.grouped()));
  });
}

/** Pull every cable, exactly as deleting the link on the canvas does. */
async function unplugEverything(page: Page): Promise<void> {
  await page.evaluate(() => {
    type StoreState = { connections: { id: string }[]; removeConnection(id: string): void };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    for (const c of [...store.getState().connections]) store.getState().removeConnection(c.id);
  });
}

async function setPower(page: Page, deviceId: string, on: boolean): Promise<void> {
  await page.evaluate(({ id, powered }) => {
    type StoreState = {
      updateDevice(id: string, u: { isPoweredOn?: boolean }): void;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    store.getState().updateDevice(id, { isPoweredOn: powered });
  }, { id: deviceId, powered: on });
}

test.describe('incident registry — physical faults', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('a healthy topology reports no incident', async ({ page }) => {
    await setupLan(page);
    expect(await allFaults(page)).toHaveLength(0);
  });

  test('pulling the cable raises a critical link fault on both ends', async ({ page }) => {
    const { pcId, srvId } = await setupLan(page);
    await unplugEverything(page);

    const pcFaults = await faultsFor(page, pcId);
    const srvFaults = await faultsFor(page, srvId);

    expect(pcFaults.map(f => f.code)).toContain('LINK_DOWN');
    expect(srvFaults.map(f => f.code)).toContain('LINK_DOWN');
    // Both ports carry an operator-configured address, so the loss is real.
    expect(pcFaults.find(f => f.code === 'LINK_DOWN')?.severity).toBe('critical');
    // The incident is worded the way `ip link` words it, so the operator
    // reads the same thing in the terminal and in the UI.
    expect(pcFaults.find(f => f.code === 'LINK_DOWN')?.summary).toContain('NO-CARRIER');
  });

  test('the incident carries the command that investigates it', async ({ page }) => {
    const { pcId } = await setupLan(page);
    await unplugEverything(page);

    const fault = (await faultsFor(page, pcId)).find(f => f.code === 'LINK_DOWN');
    expect(fault?.investigate).toMatch(/^ip link show /);
  });

  test('reconnecting the cable clears the incident completely', async ({ page }) => {
    const { pcId, srvId } = await setupLan(page);
    await unplugEverything(page);
    expect((await allFaults(page)).length).toBeGreaterThan(0);

    // Re-cable through the store, the same call the Connect flow makes.
    await page.evaluate(({ a, b }) => {
      type StoreState = {
        deviceInstances: Map<string, Record<string, unknown>>;
        addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
      };
      const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      const da = store.getState().deviceInstances.get(a)!;
      const db = store.getState().deviceInstances.get(b)!;
      const pa = (da.getPortNames as () => string[])().find(n => n.startsWith('eth'))!;
      const pb = (db.getPortNames as () => string[])().find(n => n.startsWith('eth'))!;
      store.getState().addConnection(a, pa, b, pb, 'ethernet');
    }, { a: pcId, b: srvId });

    // Principle P4: a repaired fault leaves NO residue, or the lab is not
    // replayable (docs/PRD-Pannes.md §5).
    expect(await allFaults(page)).toHaveLength(0);
  });

  test('an interface shut from the CLI is a notice, not a critical', async ({ page }) => {
    const { pcId } = await setupLan(page);

    await page.evaluate(async (id) => {
      type StoreState = { deviceInstances: Map<string, Record<string, unknown>> };
      const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      const pc = store.getState().deviceInstances.get(id)!;
      await Promise.resolve(
        (pc.executeCommand as (c: string) => unknown).call(pc, 'sudo ip link set eth0 down'),
      );
    }, pcId);

    const admin = (await faultsFor(page, pcId)).find(f => f.code === 'LINK_ADMIN_DOWN');
    expect(admin).toBeTruthy();
    // The operator asked for this: it is reported, not alarmed about.
    expect(admin?.severity).toBe('notice');
    expect(admin?.remedy).toContain('ip link set');
  });
});

test.describe('incident registry — power', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('powering a device off is one device-level notice, not one per port', async ({ page }) => {
    const { srvId } = await setupLan(page);
    await setPower(page, srvId, false);

    const own = await faultsFor(page, srvId);
    expect(own).toHaveLength(1);
    expect(own[0].code).toBe('DEVICE_POWERED_OFF');
    expect(own[0].severity).toBe('notice');
  });

  test('its neighbour reports the carrier loss it actually suffers', async ({ page }) => {
    const { pcId, srvId } = await setupLan(page);
    await setPower(page, srvId, false);

    // Counter-intuitive and exactly right: switching a device off turns its
    // NEIGHBOURS' links red (docs/PRD-Pannes.md §F2.7).
    expect((await faultsFor(page, pcId)).map(f => f.code)).toContain('LINK_DOWN');
  });

  test('powering back on clears the device fault', async ({ page }) => {
    const { srvId } = await setupLan(page);
    await setPower(page, srvId, false);
    await setPower(page, srvId, true);

    expect(await faultsFor(page, srvId)).toHaveLength(0);
  });
});

test.describe('incident registry — grouping and lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('independent faults are listed as separate roots', async ({ page }) => {
    const { pcId, srvId } = await setupLan(page);
    await setPower(page, pcId, false);
    await setPower(page, srvId, false);

    const groups = await groupedFaults(page);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    expect(groups.every(g => g.consequences.length === 0)).toBe(true);
  });

  test('deleting a device takes its incidents off the board', async ({ page }) => {
    const { pcId, srvId } = await setupLan(page);
    await unplugEverything(page);
    expect((await faultsFor(page, srvId)).length).toBeGreaterThan(0);

    await page.evaluate((id) => {
      type StoreState = { removeDevice(id: string): void };
      const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      store.getState().removeDevice(id);
    }, srvId);

    // Otherwise the incident view accumulates references to devices that
    // are no longer on the canvas (docs/PRD-Pannes.md §F2.8).
    expect(await faultsFor(page, srvId)).toHaveLength(0);
    // The other end's own fault is untouched — it is still broken.
    expect((await faultsFor(page, pcId)).length).toBeGreaterThan(0);
  });

  test('a flapping link stays a single incident', async ({ page }) => {
    const { pcId, srvId } = await setupLan(page);

    for (let i = 0; i < 3; i++) {
      await unplugEverything(page);
      await page.evaluate(({ a, b }) => {
        type StoreState = {
          deviceInstances: Map<string, Record<string, unknown>>;
          addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
        };
        const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
        const da = store.getState().deviceInstances.get(a)!;
        const db = store.getState().deviceInstances.get(b)!;
        const pa = (da.getPortNames as () => string[])().find(n => n.startsWith('eth'))!;
        const pb = (db.getPortNames as () => string[])().find(n => n.startsWith('eth'))!;
        store.getState().addConnection(a, pa, b, pb, 'ethernet');
      }, { a: pcId, b: srvId });
    }
    await unplugEverything(page);

    expect(await faultsFor(page, pcId)).toHaveLength(1);
  });

  test('clearing the canvas leaves no orphaned incident', async ({ page }) => {
    await setupLan(page);
    await unplugEverything(page);
    expect((await allFaults(page)).length).toBeGreaterThan(0);

    await page.evaluate(() => {
      type StoreState = { clearAll(): void };
      const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      store.getState().clearAll();
    });

    expect(await allFaults(page)).toHaveLength(0);
  });
});

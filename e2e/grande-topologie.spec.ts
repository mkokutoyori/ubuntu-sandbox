/**
 * Topologie de grande taille : N postes Linux sur des switchs chaines, tout configure, puis un ping de bout en bout.
 * `BIG_PCS=200 npx playwright test e2e/grande-topologie.spec.ts` ; ecrit dans /tmp/nat-lab-stress/journal.log.
 */
import { test, expect } from '@playwright/test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { waitForStore } from './helpers/natLab';

test('grande topologie', async ({ page }) => {
  test.setTimeout(900_000);
  const pcs = Number(process.env.BIG_PCS ?? 120);
  let crashed = false;
  page.on('crash', () => { crashed = true; });
  await page.goto('/');
  await waitForStore(page);
  await page.evaluate(() => {
    const w = window as Record<string, unknown>;
    w.__long = { count: 0, total: 0, max: 0 };
    new PerformanceObserver((list) => {
      const stats = w.__long as { count: number; total: number; max: number };
      for (const entry of list.getEntries()) { stats.count++; stats.total += entry.duration; stats.max = Math.max(stats.max, entry.duration); }
    }).observe({ entryTypes: ['longtask'] });
  });
  const cdp = await page.context().newCDPSession(page);
  if (process.env.PROFILE_CPU) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cdp.send('Profiler.start');
  }
  const startedAt = Date.now();
  const result = await page.evaluate(async (count) => {
    type Device = Record<string, unknown>;
    type StoreState = {
      addDevice(type: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Device>;
      addConnection(srcId: string, srcIf: string, dstId: string, dstIf: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const ports = (d: Device): string[] => (d.getPortNames as () => string[])();
    const exec = (d: Device, c: string): Promise<string> => Promise.resolve((d.executeCommand as (c: string) => Promise<string>).call(d, c));
    const perSwitch = 20;
    const switches = Math.ceil(count / perSwitch);
    const sws: { id: string; device: Device }[] = [];
    for (let i = 0; i < switches; i++) {
      const dto = store.getState().addDevice('switch-generic', 100 + i * 120, 100);
      sws.push({ id: dto.id, device: store.getState().deviceInstances.get(dto.id) as Device });
    }
    for (let i = 1; i < switches; i++) {
      store.getState().addConnection(sws[i - 1].id, ports(sws[i - 1].device)[perSwitch + 1], sws[i].id, ports(sws[i].device)[perSwitch], 'ethernet');
    }
    const hosts: { id: string; device: Device }[] = [];
    for (let i = 0; i < count; i++) {
      const sw = sws[Math.floor(i / perSwitch)];
      const dto = store.getState().addDevice('linux-pc', 100 + (i % perSwitch) * 40, 300 + Math.floor(i / perSwitch) * 60);
      const device = store.getState().deviceInstances.get(dto.id) as Device;
      store.getState().addConnection(dto.id, ports(device)[0], sw.id, ports(sw.device)[i % perSwitch], 'ethernet');
      hosts.push({ id: dto.id, device });
    }
    for (let i = 0; i < count; i++) {
      await exec(hosts[i].device, `sudo ip addr add 10.0.${Math.floor(i / 250)}.${(i % 250) + 1}/16 dev ${ports(hosts[i].device)[0]}`);
    }
    const first = hosts[0].device;
    const out = await exec(first, `ping -c 2 -W 2 10.0.${Math.floor((count - 1) / 250)}.${((count - 1) % 250) + 1}`);
    return { built: true, tail: out.split('\n').slice(-3).join(' | ') };
  }, pcs);
  if (process.env.PROFILE_CPU) {
    const { profile } = await cdp.send('Profiler.stop');
    type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
    const nodes = new Map<number, Node>((profile.nodes as Node[]).map((n) => [n.id, n]));
    const parent = new Map<number, number>();
    for (const n of profile.nodes as Node[]) for (const c of n.children ?? []) parent.set(c, n.id);
    const label = (n: Node): string => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/(src|node_modules\/\.vite)\//, '$1/').slice(0, 90)}:${n.callFrame.lineNumber}`;
    const self = new Map<string, number>();
    const incl = new Map<string, number>();
    (profile.samples as number[]).forEach((id, i) => {
      const dt = (profile.timeDeltas as number[])[i] / 1000;
      self.set(label(nodes.get(id) as Node), (self.get(label(nodes.get(id) as Node)) ?? 0) + dt);
      const seen = new Set<string>();
      for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
        const key = label(nodes.get(cur) as Node);
        if (seen.has(key)) continue;
        seen.add(key);
        incl.set(key, (incl.get(key) ?? 0) + dt);
      }
    });
    const fmt = (m: Map<string, number>, k: number): string => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([key, v]) => `${v.toFixed(0).padStart(7)}ms ${key}`).join('\n');
    writeFileSync('/tmp/claude-0/profile-grande-topologie.txt', `--- self\n${fmt(self, 25)}\n--- inclusive\n${fmt(incl, 60)}\n`);
  }
  const stats = await page.evaluate(() => ({
    long: (window as Record<string, unknown>).__long,
    heapMB: Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6),
    nodes: document.getElementsByTagName('*').length,
  }));
  appendFileSync('/tmp/nat-lab-stress/journal.log', `${new Date().toISOString()} [grande topologie ${pcs} postes] elapsed=${Date.now() - startedAt}ms crashed=${crashed} ${result.tail} stats=${JSON.stringify(stats)}\n`);
  expect(crashed).toBe(false);
  expect(result.tail).toContain('2 received');
});

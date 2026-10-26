/**
 * Fuite entre deux topologies : construit le laboratoire, le vide (`clearAll`), recommence, et mesure le tas apres ramasse-miettes (CDP).
 * `LEAK_CYCLES=8 npx playwright test e2e/nat-lab-fuite-memoire.spec.ts` ; le tas qui monte d'un cycle a l'autre est une fuite.
 */
import { test, expect } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { buildLab, waitForStore } from './helpers/natLab';

test('clearAll libere le laboratoire', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto('/');
  await waitForStore(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  const heapMB = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const usage = await cdp.send('Runtime.getHeapUsage');
    return Math.round(usage.usedSize / 1e6);
  };
  const readings: number[] = [await heapMB()];
  const cycles = Number(process.env.LEAK_CYCLES ?? 6);
  for (let cycle = 0; cycle < cycles; cycle++) {
    const ids = await buildLab(page);
    await page.evaluate(async (lin) => {
      const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, { executeCommand(c: string): Promise<string> }>; clearAll(): void } };
      const device = store.getState().deviceInstances.get(lin) as { executeCommand(c: string): Promise<string> };
      await device.executeCommand('for i in $(seq 1 100); do curl -s -o /dev/null --max-time 5 http://203.0.113.9/ & done; wait');
      store.getState().clearAll();
    }, ids.lin);
    await page.waitForTimeout(500);
    readings.push(await heapMB());
  }
  appendFileSync('/tmp/nat-lab-stress/journal.log', `${new Date().toISOString()} [fuite clearAll] heapMB apres chaque cycle=${readings.join(',')}\n`);
  expect(readings[readings.length - 1] - readings[1]).toBeLessThan(60);
});

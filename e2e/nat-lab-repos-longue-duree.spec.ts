/**
 * Le laboratoire tourne sans que personne ne tape rien : le tas ne doit pas monter. `IDLE_MINUTES=3 npx playwright test e2e/nat-lab-repos-longue-duree.spec.ts`.
 */
import { test, expect } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { buildLab, openTerminal, typeIn, waitForStore } from './helpers/natLab';

test('repos de longue duree', async ({ page }) => {
  const minutes = Number(process.env.IDLE_MINUTES ?? 3);
  test.setTimeout((minutes + 4) * 60_000);
  await page.goto('/');
  await waitForStore(page);
  const ids = await buildLab(page);
  await openTerminal(page, ids.r);
  await typeIn(page, ids.r, 'enable');
  await typeIn(page, ids.r, 'debug ip nat');
  await openTerminal(page, ids.lin);
  await typeIn(page, ids.lin, 'ping 203.0.113.9');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  const heapMB = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage');
    return Math.round((await cdp.send('Runtime.getHeapUsage')).usedSize / 1e6);
  };
  const readings = [await heapMB()];
  for (let minute = 1; minute <= minutes; minute++) {
    await page.waitForTimeout(60_000);
    readings.push(await heapMB());
  }
  const lines = await page.locator('[data-testid="terminal-modal"]').first().locator('div').count();
  appendFileSync('/tmp/nat-lab-stress/journal.log', `${new Date().toISOString()} [repos ${minutes} min, ping continu] heapMB par minute=${readings.join(',')} divs=${lines}\n`);
  expect(readings[readings.length - 1] - readings[1]).toBeLessThan(100);
});

/**
 * Toutes les machines du laboratoire travaillent en meme temps, chacune dans son terminal.
 * `npx playwright test e2e/nat-lab-tout-en-meme-temps.spec.ts` ; ecrit dans /tmp/nat-lab-stress/journal.log.
 */
import { test, expect } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { buildLab, lineCount, lineCountContaining, openTerminal, typeIn, waitForStore } from './helpers/natLab';

test('tout en meme temps', async ({ page }) => {
  test.setTimeout(900_000);
  let crashed = false;
  page.on('crash', () => { crashed = true; });
  await page.goto('/');
  await waitForStore(page);
  const ids = await buildLab(page);
  for (const id of [ids.r, ids.isp, ids.win, ids.lin, ids.srv, ids.ext]) await openTerminal(page, id);
  await typeIn(page, ids.r, 'enable');
  await typeIn(page, ids.isp, 'enable');
  await page.evaluate(() => { const w = window as Record<string, unknown>; w.__beat = Date.now(); w.__long = { count: 0, total: 0, max: 0 }; setInterval(() => { w.__beat = Date.now(); }, 100); new PerformanceObserver((list) => { const stats = w.__long as { count: number; total: number; max: number }; for (const entry of list.getEntries()) { stats.count++; stats.total += entry.duration; stats.max = Math.max(stats.max, entry.duration); } }).observe({ entryTypes: ['longtask'] }); });
  const startedAt = Date.now();
  await typeIn(page, ids.lin, 'for i in $(seq 1 500); do curl -s -o /dev/null --max-time 5 http://203.0.113.9/ & done; wait; echo DONE_LIN');
  await typeIn(page, ids.srv, 'ping -f -c 3000 192.168.10.1; echo DONE_SRV');
  await typeIn(page, ids.ext, 'nmap -p- 203.0.113.2; echo DONE_EXT');
  await typeIn(page, ids.win, 'ping -n 300 203.0.113.9 > NUL & echo DONE_WIN');
  await typeIn(page, ids.r, 'ping 203.0.113.1 repeat 3000');
  await typeIn(page, ids.isp, 'ping 203.0.113.2 repeat 3000');
  let maxLag = 0;
  const pending = new Set(['DONE_LIN', 'DONE_SRV', 'DONE_EXT', 'DONE_WIN']);
  for (let tick = 0; tick < 600 && pending.size > 0 && !crashed; tick++) {
    await page.waitForTimeout(1000);
    const lag = await Promise.race([
      page.evaluate(() => Date.now() - ((window as Record<string, unknown>).__beat as number)).catch(() => -1),
      new Promise<number>((resolve) => setTimeout(() => resolve(-2), 15_000)),
    ]);
    if (lag < 0) break;
    maxLag = Math.max(maxLag, lag);
    for (const [marker, device] of [['DONE_LIN', ids.lin], ['DONE_SRV', ids.srv], ['DONE_EXT', ids.ext], ['DONE_WIN', ids.win]] as const) {
      if (pending.has(marker) && await lineCount(page, device, marker) > 0) pending.delete(marker);
    }
  }
  const routerDone = await lineCountContaining(page, ids.r, 'Success rate is');
  const stats = await page.evaluate(() => ({ long: (window as Record<string, unknown>).__long, nodes: document.getElementsByTagName('*').length }));
  appendFileSync('/tmp/nat-lab-stress/journal.log', `${new Date().toISOString()} [tout en meme temps] elapsed=${Date.now() - startedAt}ms crashed=${crashed} maxLag=${maxLag}ms pending=${[...pending].join(',') || 'aucun'} routerPing=${routerDone} stats=${JSON.stringify(stats)}\n`);
  expect(crashed).toBe(false);
  expect(maxLag).toBeLessThan(3000);
});

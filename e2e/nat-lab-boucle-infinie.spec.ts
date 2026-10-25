/**
 * Boucles qui ne finissent jamais : la page doit rester reactive et Ctrl-C doit rendre la main.
 * `STRESS_LOOP='while true; do :; done' npx playwright test e2e/nat-lab-boucle-infinie.spec.ts`
 */
import { test, expect } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { buildLab, lineCount, openTerminal, typeIn, waitForStore } from './helpers/natLab';

const LOOPS = (process.env.STRESS_LOOP ? [process.env.STRESS_LOOP] : [
  'while true; do :; done',
  'while true; do echo spin; done',
  'while true; do logger -t spin x; done',
  'for ((;;)); do :; done',
  'yes > /dev/null',
  'cat /dev/zero | head -c 100000000 | wc -c',
]);

for (const loop of LOOPS) {
  test(`boucle infinie ${loop}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await waitForStore(page);
    const ids = await buildLab(page);
    await openTerminal(page, ids.lin);
    await page.waitForTimeout(1000);
    await page.evaluate(() => { const w = window as Record<string, unknown>; w.__beat = Date.now(); setInterval(() => { w.__beat = Date.now(); }, 100); });
    await typeIn(page, ids.lin, loop).catch((error: Error) => appendFileSync('/tmp/nat-lab-stress/journal.log', `[${loop}] typeIn failed ${error.message.slice(0, 80)}\n`));
    let maxLag = 0;
    for (let tick = 0; tick < 5; tick++) {
      await page.waitForTimeout(1000);
      const lag = await Promise.race([
        page.evaluate(() => Date.now() - ((window as Record<string, unknown>).__beat as number)).catch(() => -1),
        new Promise<number>((resolve) => setTimeout(() => resolve(-2), 10_000)),
      ]);
      maxLag = Math.max(maxLag, lag);
      if (lag < 0) break;
    }
    const modal = page.locator(`[data-testid="terminal-modal"][data-device-id="${ids.lin}"]`);
    await modal.locator('input[type="text"]').last().press('Control+c').catch(() => undefined);
    await page.waitForTimeout(1500);
    await typeIn(page, ids.lin, 'echo STILL_ALIVE').catch(() => undefined);
    await page.waitForTimeout(1500);
    const alive = await lineCount(page, ids.lin, 'STILL_ALIVE') > 0;
    appendFileSync('/tmp/nat-lab-stress/journal.log', `${new Date().toISOString()} [loop ${loop}] maxLag=${maxLag}ms alive=${alive}\n`);
    expect(maxLag).toBeLessThan(3000);
    expect(alive).toBe(true);
  });
}

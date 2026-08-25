import { test, expect } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand, termText, type SshLab,
} from './helpers/sshLab';

test.describe('the canvas follows autonomous changes without a shared bus', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
  });

  test('a link brought down from the CLI is reflected on the canvas', async ({ page }) => {
    const before = await page.evaluate(() =>
      (window as unknown as { __networkStore: { getState(): { revision: number } } })
        .__networkStore.getState().revision);

    await openTerminal(page, lab.linux1);
    await typeCommand(page, 'ip link set eth0 down');

    await expect.poll(async () => page.evaluate(() =>
      (window as unknown as { __networkStore: { getState(): { revision: number } } })
        .__networkStore.getState().revision), { timeout: 30_000 }).toBeGreaterThan(before);
  });

  test('a ping still crosses, so the machines still talk over the wire',
    async ({ page }) => {
      await openTerminal(page, lab.linux1);
      await typeCommand(page, `ping -c 2 ${lab.ip.linux2}`);

      await expect.poll(
        async () => /2 received|0% packet loss/.test(await termText(page)),
        { timeout: 30_000 }).toBe(true);
    });
});

import { test, expect } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand, termText, type SshLab,
} from './helpers/sshLab';

test.describe('the link layer classifies frames in the real browser', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
  });

  test('a ping still crosses after the classification moved into the layer',
    async ({ page }) => {
      await openTerminal(page, lab.linux1);
      await typeCommand(page, `ping -c 2 ${lab.ip.linux2}`);

      await expect.poll(
        async () => /2 received|0% packet loss/.test(await termText(page)),
        { timeout: 30_000 }).toBe(true);
    });

  test('a promiscuous interface still forwards its own traffic',
    async ({ page }) => {
      await openTerminal(page, lab.linux1);
      await typeCommand(page, 'ip link set eth0 promisc on');
      await typeCommand(page, `ping -c 2 ${lab.ip.linux2}`);

      await expect.poll(
        async () => /2 received|0% packet loss/.test(await termText(page)),
        { timeout: 30_000 }).toBe(true);
    });

  test('a router still answers a ping to its own interface', async ({ page }) => {
    await openTerminal(page, lab.linux1);
    await typeCommand(page, `ping -c 2 ${lab.ip.ciscoR1}`);

    await expect.poll(
      async () => /2 received|0% packet loss/.test(await termText(page)),
      { timeout: 30_000 }).toBe(true);
  });
});

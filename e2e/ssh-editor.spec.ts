import { test, expect } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand,
  sshLogin, type SshLab,
} from './helpers/sshLab';

const SHOTS = 'e2e/screenshots';

test.describe('Editors over SSH', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
    await openTerminal(page, lab.win1);
  });

  test('Windows -> Linux: nano opens the GNU nano editor overlay', async ({ page }) => {
    await sshLogin(page, lab.ip.linux1, 'user', 'admin');
    await typeCommand(page, 'nano /tmp/hello.txt');
    await expect(page.getByText('GNU nano')).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: `${SHOTS}/win-to-linux-nano.png` });
  });

  test('Windows -> Linux: vim opens the VIM editor overlay', async ({ page }) => {
    await sshLogin(page, lab.ip.linux1, 'user', 'admin');
    await typeCommand(page, 'vim /tmp/fresh-vim.txt');
    await expect(page.getByText('VIM - Vi IMproved')).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: `${SHOTS}/win-to-linux-vim.png` });
  });
});

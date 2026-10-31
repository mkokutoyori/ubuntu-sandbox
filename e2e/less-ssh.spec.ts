import { test, expect } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand, typePassword, termText, sshLogin,
} from './helpers/sshLab';

async function exerciseLess(page: import('@playwright/test').Page): Promise<void> {
  await typeCommand(page, 'seq 1 200 > /tmp/big.txt');
  await typeCommand(page, 'less /tmp/big.txt');
  const body = page.locator('[data-testid="less-body"]');
  await expect(body).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="less-line"]').first()).toHaveText('1');
  await page.keyboard.press('Space');
  const first = await page.locator('[data-testid="less-line"]').first().innerText();
  expect(Number(first)).toBeGreaterThan(5);
  await page.keyboard.type('/^150$');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="less-line"]').first()).toHaveText('150');
  await page.keyboard.press('q');
  await expect(body).toHaveCount(0);

  await typeCommand(page, 'seq 1 80 | less');
  await expect(page.locator('[data-testid="less-line"]').first()).toHaveText('1');
  await page.keyboard.press('q');
  await expect(body).toHaveCount(0);

  await typeCommand(page, 'less --help');
  await expect(body).toContainText('SUMMARY OF LESS COMMANDS');
  await page.keyboard.press('q');
  await expect(body).toHaveCount(0);

  await typeCommand(page, 'less /tmp/inexistant');
  await expect.poll(() => termText(page)).toContain('/tmp/inexistant: No such file or directory');
  await typeCommand(page, 'echo retour-shell');
  await expect.poll(() => termText(page)).toMatch(/\nretour-shell/);
}

test.describe('less se comporte pareil quel que soit le terminal', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('Linux -> SSH -> Linux', async ({ page }) => {
    const lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
    await sshLogin(page, lab.ip.linux2, 'user', 'admin');
    await exerciseLess(page);
  });

  test('Cisco IOS -> SSH -> Linux', async ({ page }) => {
    const lab = await buildSshLab(page);
    await page.evaluate(async (id) => {
      const store = (window as unknown as { __networkStore: { getState(): { deviceInstances: Map<string, { executeCommand(c: string): Promise<string> }> } } }).__networkStore;
      const device = store.getState().deviceInstances.get(id)!;
      await device.executeCommand("sudo sh -c 'printf \"KexAlgorithms +diffie-hellman-group14-sha1\\nHostKeyAlgorithms +ssh-rsa\\n\" >> /etc/ssh/sshd_config'");
      await device.executeCommand('sudo systemctl reload ssh');
    }, lab.linux1);
    await openTerminal(page, lab.ciscoR1);
    await typeCommand(page, 'ssh -l user 10.0.0.1');
    await typePassword(page, 'admin');
    await expect.poll(() => termText(page)).toContain('user@PC1');
    await exerciseLess(page);
  });

  test('Windows -> SSH -> Linux', async ({ page }) => {
    const lab = await buildSshLab(page);
    await openTerminal(page, lab.win1);
    await sshLogin(page, lab.ip.linux1, 'user', 'admin');
    await exerciseLess(page);
  });
});

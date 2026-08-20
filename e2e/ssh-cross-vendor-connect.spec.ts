import { test, expect } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand, typePassword,
  termText, runAndCapture, sshLogin, inTerminal, TARGETS, type SshLab,
} from './helpers/sshLab';

test.describe('SSH connection behaviour (cross-vendor)', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
  });

  for (const t of Object.values(TARGETS)) {
    test(`Linux → ${t.label}: a correct password lands on the native prompt`, async ({ page }) => {
      const out = await sshLogin(page, t.ip, t.user, t.pass);
      expect(out).toMatch(t.prompt);
    });
  }

  test('first connection prints the known-hosts warning', async ({ page }) => {
    const out = await sshLogin(page, TARGETS.linux2.ip, 'user', 'admin');
    expect(out).toMatch(/Permanently added|known hosts/);
  });

  test('a wrong password is rejected with "Permission denied"', async ({ page }) => {
    await typeCommand(page, `ssh user@${TARGETS.linux2.ip}`);
    const pw = page.locator('[data-testid="terminal-modal"] input[type="password"]');
    await expect(pw).toBeVisible({ timeout: 9_000 });
    await typePassword(page, 'definitely-wrong');
    await expect(inTerminal(page, 'Permission denied')).toBeVisible({ timeout: 8_000 });
  });

  test('exit from a remote Linux session returns to the local shell', async ({ page }) => {
    await sshLogin(page, TARGETS.linux2.ip, 'user', 'admin');
    await typeCommand(page, 'exit');
    await page.waitForTimeout(900);
    const full = await termText(page);
    expect(full).toMatch(/Connection to 10\.0\.0\.2 closed/);
    expect(full).toMatch(/user@PC1:~\$\s*$/);
  });

  test('exit from a remote Cisco session returns to the local shell', async ({ page }) => {
    await sshLogin(page, TARGETS.ciscoR1.ip, 'admin', 'Admin@123');
    await typeCommand(page, 'exit');
    await page.waitForTimeout(900);
    const full = await termText(page);
    expect(full).toMatch(/Connection to 10\.0\.0\.6 closed/);
    expect(full).toMatch(/user@PC1:~\$\s*$/);
  });

  test('exit from a remote Huawei session returns to the local shell', async ({ page }) => {
    await sshLogin(page, TARGETS.hwR1.ip, 'admin', 'Admin@123');
    await typeCommand(page, 'quit');
    await page.waitForTimeout(900);
    const full = await termText(page);
    expect(full).toMatch(/Connection to 10\.0\.0\.8 closed/);
    expect(full).toMatch(/user@PC1:~\$\s*$/);
  });

  test('ssh to an unreachable host reports no route / timeout', async ({ page }) => {
    const out = await runAndCapture(page, 'ssh user@10.0.0.99', 4_000);
    expect(out).toMatch(/No route to host|connect to host|Connection timed out|Network is unreachable/);
  });
});

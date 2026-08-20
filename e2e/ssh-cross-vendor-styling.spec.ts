import { test, expect } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand, typePassword,
  termText, runAndCapture, sshLogin, TARGETS, type SshLab,
} from './helpers/sshLab';

test.describe('SSH data styling & presentation (cross-vendor)', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
  });

  for (const t of Object.values(TARGETS)) {
    test(`${t.label}: the password is never echoed (no asterisks), like real OpenSSH`, async ({ page }) => {
      await typeCommand(page, `ssh ${t.user}@${t.ip}`);
      const pw = page.locator('[data-testid="terminal-modal"] input[type="password"]');
      await expect(pw).toBeVisible({ timeout: 9_000 });
      await typePassword(page, t.pass);
      await page.waitForTimeout(700);
      const full = await termText(page);
      expect(full).not.toMatch(/password:\s*\*+/i);
    });
  }

  test('Linux: SSH login renders the Ubuntu MOTD banner', async ({ page }) => {
    const out = await sshLogin(page, TARGETS.linux2.ip, 'user', 'admin');
    expect(out).toMatch(/Welcome to Ubuntu/);
  });

  test('Linux: the remote prompt is user@host:cwd$ in shell colours', async ({ page }) => {
    await sshLogin(page, TARGETS.linux2.ip, 'user', 'admin');
    const full = await termText(page);
    expect(full).toMatch(/user@PC2:~\$/);
  });

  test('Windows: the remote prompt is a Windows drive path ending with >', async ({ page }) => {
    await sshLogin(page, TARGETS.win1.ip, 'carl', 'carl');
    const full = await termText(page);
    expect(full).toMatch(/C:\\Users\\carl>/);
    expect(full).not.toMatch(/carl@.*:.*\$/);
  });

  test('Cisco: the prompt is the hostname in privileged-exec form (hostname#)', async ({ page }) => {
    await sshLogin(page, TARGETS.ciscoR1.ip, 'admin', 'Admin@123');
    const full = await termText(page);
    expect(full).toMatch(/ciscoR1#/);
  });

  test('Huawei: the prompt is the user view <hostname>', async ({ page }) => {
    await sshLogin(page, TARGETS.hwR1.ip, 'admin', 'Admin@123');
    const full = await termText(page);
    expect(full).toMatch(/<hwR1>/);
  });

  test('Cisco: "show ip interface brief" renders an aligned status table', async ({ page }) => {
    await sshLogin(page, TARGETS.ciscoR1.ip, 'admin', 'Admin@123');
    const out = await runAndCapture(page, 'show ip interface brief', 700);
    expect(out).toMatch(/Interface\s+IP-Address\s+OK\?\s+Method\s+Status\s+Protocol/);
    expect(out).toMatch(/GigabitEthernet0\/0\s+10\.0\.0\.6\s+YES/);
  });

  test('Cisco: "show running-config" presents config in IOS section style', async ({ page }) => {
    await sshLogin(page, TARGETS.ciscoR1.ip, 'admin', 'Admin@123');
    const out = await runAndCapture(page, 'show running-config', 800);
    expect(out).toMatch(/Building configuration/);
    expect(out).toMatch(/interface GigabitEthernet0\/0/);
    expect(out).toMatch(/ip address 10\.0\.0\.6 255\.255\.255\.0/);
  });

  test('Huawei: "display ip interface brief" matches real VRP formatting', async ({ page }) => {
    await sshLogin(page, TARGETS.hwR1.ip, 'admin', 'Admin@123');
    const out = await runAndCapture(page, 'display ip interface brief', 700);
    expect(out).toMatch(/Interface\s+IP Address\/Mask\s+Physical\s+Protocol/);
    expect.soft(out).toMatch(/GigabitEthernet0\/0\/0\s+10\.0\.0\.8\/24/);
    expect.soft(out).toMatch(/10\.0\.0\.8\/24\s+up\s+up/);
  });

  test('Windows: "dir" output shows the directory listing header', async ({ page }) => {
    await sshLogin(page, TARGETS.win1.ip, 'carl', 'carl');
    const out = await runAndCapture(page, 'dir', 700);
    expect(out).toMatch(/Directory of C:\\Users\\carl/);
    expect(out).toMatch(/<DIR>|bytes free/);
  });

  test('Linux: "ls -l" over SSH shows long-format columns', async ({ page }) => {
    await sshLogin(page, TARGETS.linux2.ip, 'user', 'admin');
    const out = await runAndCapture(page, 'ls -l /', 700);
    expect(out).toMatch(/total\s+\d+/);
    expect(out).toMatch(/drwx/);
  });

  test('Linux: the remote prompt user@host is coloured shell-green', async ({ page }) => {
    await sshLogin(page, TARGETS.linux2.ip, 'user', 'admin');
    await runAndCapture(page, 'pwd', 600);
    const span = page.locator('[data-testid="terminal-modal"] span', { hasText: 'user@PC2' }).first();
    await expect(span).toBeVisible({ timeout: 5_000 });
    const color = await span.evaluate(el => getComputedStyle(el).color);
    expect(color).toMatch(/rgb\(138, 226, 52\)/);
  });

  test('Windows: "ipconfig" over SSH reports the configured IPv4 address', async ({ page }) => {
    await sshLogin(page, TARGETS.win1.ip, 'carl', 'carl');
    const out = await runAndCapture(page, 'ipconfig', 700);
    expect(out).toMatch(/IPv4 Address[. ]*: 10\.0\.0\.4/);
  });
});

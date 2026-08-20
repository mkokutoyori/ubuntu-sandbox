import { test, expect } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand, typePassword,
  runAndCapture, termText, TARGETS, type SshLab,
} from './helpers/sshLab';

/**
 * `ssh -R` opens its listener on the REMOTE machine, and the remote's own
 * `ss -tln` is where that shows.
 *
 * The byte-level proof that the three forwarders relay for real lives in
 * `ssh-forwards-interactifs-relaient.test.ts`: no client available at a
 * prompt dials a forwarded loopback port yet — the interactive session's
 * forwarders and the `executeCommand` forwarding table are two stacks that
 * do not share a table (the SSH-unification chantier). What a browser can
 * see, and what this spec pins, is the other half: the forward is
 * announced, its listener really exists on the far machine while the
 * session is open, and it is gone once the session closes.
 */

test.describe('ssh -R publishes its listener on the remote machine', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
  });

  test('the listener appears on the remote and leaves with the session', async ({ page }) => {
    const before = (await termText(page)).length;
    await typeCommand(
      page,
      `ssh -R 15100:127.0.0.1:22 ${TARGETS.linux2.user}@${TARGETS.linux2.ip}`,
    );
    const pw = page.locator('[data-testid="terminal-modal"] input[type="password"]');
    await expect(pw).toBeVisible({ timeout: 9_000 });
    await typePassword(page, TARGETS.linux2.pass);
    await page.waitForTimeout(2_000);

    const opened = (await termText(page)).slice(before);
    expect(opened).toMatch(/Forwarding .*15100 .* 127\.0\.0\.1:22 \(reverse\)/);
    expect(opened, 'the session must really be up for the rest to mean anything')
      .toMatch(TARGETS.linux2.prompt);

    const listening = await runAndCapture(page, 'ss -tln', 1_500);
    expect(listening, 'the reverse forward listens on the remote, not on the client')
      .toMatch(/0\.0\.0\.0:15100/);

    await typeCommand(page, 'exit');
    await page.waitForTimeout(1_500);
    const local = await runAndCapture(page, 'ss -tln', 1_500);
    expect(local, 'back on the client, that port was never ours').not.toMatch(/:15100/);
  });
});

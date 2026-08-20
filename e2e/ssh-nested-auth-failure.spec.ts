import { test, expect } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand, typePassword,
  termText, sshHop, TARGETS, type SshLab,
} from './helpers/sshLab';

/**
 * A nested `ssh` says why it is asking again.
 *
 * `PRD-SSH-Unification` §6.2 measured this and left it open: a bare
 * `ssh user@host` typed inside a remote session is a THIRD client path —
 * `SshInteractiveSubShell.startNestedHop`, not `sshLauncher` and not the
 * terminal's own first hop. It re-prompted after a wrong password
 * without ever printing OpenSSH's `Permission denied, please try again.`,
 * so the operator saw two identical prompts and no reason for the second.
 *
 * Two things caused it, and both are silent by construction.
 * `HopInteractionHandler` did not implement `showAuthFailure`, which
 * `SshSession` calls through an OPTIONAL method — so the call was a
 * no-op rather than an error. And `pumpHopConnect` returned `output: []`
 * on the prompt branch, discarding whatever the handler had collected
 * before the next prompt.
 *
 * This is a rendering defect, so the browser is where it is provable:
 * the assertion is on what the operator reads.
 */

test.describe('a nested ssh explains its second prompt', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
  });

  test('a wrong password at depth 2 prints OpenSSH\'s reason', async ({ page }) => {
    expect(await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin'))
      .toMatch(/user@PC2:~\$/);

    const before = (await termText(page)).length;
    await typeCommand(page, `ssh user@${lab.ip.linux1}`);
    const pw = page.locator('[data-testid="terminal-modal"] input[type="password"]');
    await expect(pw).toBeVisible({ timeout: 9_000 });
    await typePassword(page, 'wrong');
    await page.waitForTimeout(1_500);

    const after = (await termText(page)).slice(before);
    expect(after).toContain('Permission denied, please try again.');
  });

  test('the reference: the right password still says nothing of the sort', async ({ page }) => {
    expect(await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin'))
      .toMatch(/user@PC2:~\$/);

    const before = (await termText(page)).length;
    const hop = await sshHop(page, `ssh user@${lab.ip.linux1}`, 'admin');
    expect(hop).toMatch(/user@PC1:~\$/);
    expect((await termText(page)).slice(before))
      .not.toContain('Permission denied, please try again.');
  });
});

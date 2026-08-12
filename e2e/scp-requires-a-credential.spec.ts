import { test, expect } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand, typePassword,
  termText, TARGETS, type SshLab,
} from './helpers/sshLab';

/**
 * A `scp` that authenticates nothing transfers nothing.
 *
 * Phase 4 of `PRD-SSH-Unification` removed the in-memory fallback that
 * used to repair a failed wire authentication by copying VFS to VFS —
 * the file arrived without ever having travelled. At a terminal the
 * client asks for the password like real OpenSSH does, so what is
 * provable here is the other half: a WRONG answer stops the transfer,
 * and the right one carries it.
 */

test.describe('scp over the wire needs a real credential', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
  });

  test('a wrong password at the prompt refuses the transfer', async ({ page }) => {
    await typeCommand(page, 'echo carried > /tmp/carried.txt');
    const before = (await termText(page)).length;
    await typeCommand(page, `scp /tmp/carried.txt user@${TARGETS.linux2.ip}:/tmp/carried.txt`);
    const pw = page.locator('[data-testid="terminal-modal"] input[type="password"]');
    await expect(pw).toBeVisible({ timeout: 9_000 });
    await typePassword(page, 'not-the-password');
    await page.waitForTimeout(2_000);

    const after = (await termText(page)).slice(before);
    expect(after).toMatch(/Permission denied/);
    expect(after).not.toMatch(/100%|bytes transferred/i);
  });

  test('the reference: the right password carries the file', async ({ page }) => {
    await typeCommand(page, 'echo carried > /tmp/carried.txt');
    const before = (await termText(page)).length;
    await typeCommand(
      page,
      `sshpass -p ${TARGETS.linux2.pass} scp /tmp/carried.txt user@${TARGETS.linux2.ip}:/tmp/carried.txt`,
    );
    await page.waitForTimeout(2_000);

    const after = (await termText(page)).slice(before);
    expect(after).not.toMatch(/Permission denied/);
    expect(after).toMatch(/100%|bytes transferred/i);
  });
});

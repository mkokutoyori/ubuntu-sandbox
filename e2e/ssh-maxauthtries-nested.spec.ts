import { test, expect, type Page } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand, typePassword,
  termText, sshHop, TARGETS, type SshLab,
} from './helpers/sshLab';

/**
 * `MaxAuthTries` seen by the operator, at the second hop.
 *
 * The browser counterpart of
 * `ssh-client-stops-when-server-hangs-up.test.ts`. The unit test counts
 * prompts at the wire session, which is the only place the count is
 * exact; this one checks what the terminal actually shows, because a
 * client that stops asking but keeps an input field open would satisfy
 * the first and fail the operator.
 *
 * The second hop is what makes this worth testing in the browser: it
 * goes through `SshInteractiveSubShell.startNestedHop`, the third
 * interactive client of `PRD-SSH-Unification` §6.2, and the fix landed
 * on the wire path all three share.
 */

/**
 * Written through the device's own filesystem rather than typed at the
 * prompt: the lab's default user is not root, so a redirection into
 * `/etc/ssh/sshd_config` is silently refused — a first version of this
 * helper appended nothing and the file still read `MaxAuthTries 6`,
 * which would have made a failing assertion look like a product defect.
 * The directive is REPLACED, not appended, because the seeded config
 * already carries one and sshd honours the first occurrence.
 */
async function setMaxAuthTries(page: Page, deviceId: string, n: number): Promise<void> {
  const applied = await page.evaluate(async ({ id, tries }) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { deviceInstances: Map<string, Record<string, unknown>> };
    };
    const device = store.getState().deviceInstances.get(id) as Record<string, unknown>;
    const vfs = (device as unknown as {
      executor: { vfs: {
        readFile(p: string): string | null;
        writeFile(p: string, c: string, u: number, g: number, m: number): void;
      } };
    }).executor.vfs;
    const path = '/etc/ssh/sshd_config';
    const current = vfs.readFile(path) ?? '';
    const next = /^MaxAuthTries\b.*$/m.test(current)
      ? current.replace(/^MaxAuthTries\b.*$/m, `MaxAuthTries ${tries}`)
      : `${current}\nMaxAuthTries ${tries}\n`;
    vfs.writeFile(path, next, 0, 0, 0o022);
    const exec = device.executeCommand as (cmd: string) => Promise<string> | string;
    await Promise.resolve(exec.call(device, 'systemctl restart ssh'));
    const ctx = (device as unknown as {
      getSshServerContext?: () => { config?: { maxAuthTries?: number } };
    }).getSshServerContext?.();
    return ctx?.config?.maxAuthTries ?? -1;
  }, { id: deviceId, tries: n });
  expect(applied, 'the server must really be running with this MaxAuthTries').toBe(n);
}

function countPrompts(transcript: string): number {
  return (transcript.match(/password:/g) ?? []).length;
}

test.describe('MaxAuthTries seen from the terminal', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
  });

  test('MaxAuthTries 1 asks once and does not ask again', async ({ page }) => {
    await setMaxAuthTries(page, lab.linux1, 1);
    expect(await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin'))
      .toMatch(/user@PC2:~\$/);

    const before = (await termText(page)).length;
    await typeCommand(page, `ssh user@${lab.ip.linux1}`);
    const pw = page.locator('[data-testid="terminal-modal"] input[type="password"]');
    await expect(pw).toBeVisible({ timeout: 9_000 });
    await typePassword(page, 'wrong');
    await page.waitForTimeout(1_800);

    const after = (await termText(page)).slice(before);
    expect(countPrompts(after)).toBe(1);
    expect(after).toContain('Permission denied');
    expect(after).not.toContain('Permission denied, please try again.');
  });

  test('the reference: the default still asks three times', async ({ page }) => {
    expect(await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin'))
      .toMatch(/user@PC2:~\$/);

    const before = (await termText(page)).length;
    await typeCommand(page, `ssh user@${lab.ip.linux1}`);
    for (let i = 0; i < 3; i++) {
      const pw = page.locator('[data-testid="terminal-modal"] input[type="password"]');
      await expect(pw).toBeVisible({ timeout: 9_000 });
      await typePassword(page, 'wrong');
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(800);

    const after = (await termText(page)).slice(before);
    expect(countPrompts(after)).toBe(3);
    expect(after).toContain('Permission denied, please try again.');
  });

  test('and the right password still connects under MaxAuthTries 1', async ({ page }) => {
    await setMaxAuthTries(page, lab.linux1, 1);
    expect(await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin'))
      .toMatch(/user@PC2:~\$/);
    expect(await sshHop(page, `ssh user@${lab.ip.linux1}`, 'admin'))
      .toMatch(/user@PC1:~\$/);
  });
});

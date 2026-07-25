import { test, expect, type Page } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand,
  termText, sshHop, TARGETS, type SshLab,
} from './helpers/sshLab';

const SHOTS = 'e2e/screenshots';

/** What `cat` on linux2's own device reports — the remote's real file. */
function remoteFile(page: Page, deviceId: string, path: string): Promise<string> {
  return page.evaluate(async ([id, p]) => {
    type Dev = Record<string, unknown>;
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { deviceInstances: Map<string, Dev> };
    };
    const dev = store.getState().deviceInstances.get(id!) as Dev;
    const fn = dev.executeCommand as (c: string) => Promise<string> | string;
    return Promise.resolve(fn.call(dev, `cat ${p}`));
  }, [deviceId, path]);
}

async function typeKeys(page: Page, keys: readonly string[], settleMs = 220): Promise<void> {
  for (const k of keys) {
    await page.keyboard.press(k);
    await page.waitForTimeout(settleMs);
  }
}

test.describe('Editors over a real SSH wire edit the remote file', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
    // Origin is a Linux box, so the hop goes over the real wire
    // (SshInteractiveSubShell) rather than the in-memory push.
    await openTerminal(page, lab.linux1);
  });

  test('vim opens on the remote and :wq writes the remote file', async ({ page }) => {
    const hop = await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin');
    expect(hop, 'the hop should land on linux2').toMatch(/user@PC2:~\$/);

    await typeCommand(page, 'vim /tmp/over-the-wire.txt');
    await expect(page.getByText('VIM - Vi IMproved')).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${SHOTS}/ssh-wire-vim-open.png` });

    await typeKeys(page, ['i']);
    await page.keyboard.type('written-remotely');
    await page.waitForTimeout(300);
    await typeKeys(page, ['Escape']);
    await page.keyboard.type(':wq');
    await page.waitForTimeout(300);
    await typeKeys(page, ['Enter'], 1200);

    expect(
      await remoteFile(page, lab.linux2, '/tmp/over-the-wire.txt'),
      'the buffer must have been written on linux2, not locally',
    ).toContain('written-remotely');
    expect(
      await remoteFile(page, lab.linux1, '/tmp/over-the-wire.txt'),
      'nothing should have been written on the client',
    ).not.toContain('written-remotely');
  });

  test('the SSH prompt comes back once the editor exits', async ({ page }) => {
    await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin');

    await typeCommand(page, 'vim /tmp/quit-me.txt');
    await expect(page.getByText('VIM - Vi IMproved')).toBeVisible({ timeout: 10_000 });

    await page.keyboard.type(':q!');
    await page.waitForTimeout(300);
    await typeKeys(page, ['Enter'], 1200);

    await expect(page.getByText('VIM - Vi IMproved')).toBeHidden({ timeout: 10_000 });
    expect(await termText(page), 'the remote shell prompt should be back').toMatch(/user@PC2/);
  });

  test('nano opens on the remote too', async ({ page }) => {
    await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin');
    await typeCommand(page, 'nano /tmp/wire-nano.txt');
    await expect(page.getByText('GNU nano')).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${SHOTS}/ssh-wire-nano-open.png` });
  });

  test('an existing remote file opens with its remote content', async ({ page }) => {
    await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin');
    await typeCommand(page, 'echo seeded-on-remote > /tmp/seeded.txt');
    await page.waitForTimeout(600);

    await typeCommand(page, 'vim /tmp/seeded.txt');
    await page.waitForTimeout(1_500);
    // An existing file gets no splash — the buffer shows what is on the
    // remote's disk, and the ruler reports its real size.
    await expect(page.getByText('VIM - Vi IMproved')).toBeHidden();
    // The buffer itself lives in the editor's textarea, not in the
    // terminal's scrollback.
    expect(await page.locator('textarea').first().inputValue())
      .toContain('seeded-on-remote');
    expect(await termText(page), 'and the ruler reports the remote file size')
      .toContain('1L, 17C');
  });
});

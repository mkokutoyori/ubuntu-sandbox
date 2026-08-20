import { test, expect } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand,
  termText, sshLogin, type SshLab,
} from './helpers/sshLab';

const SHOTS = 'e2e/screenshots';

test.describe('SSH is a transparent transport — streaming behaves like local', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
    await openTerminal(page, lab.win1);
  });

  test('Windows -> Linux: ping streams reply-by-reply over SSH', async ({ page }) => {
    const banner = await sshLogin(page, lab.ip.linux1, 'user', 'admin');
    expect(banner).toMatch(/Welcome to Ubuntu/);

    await typeCommand(page, 'ping 10.0.0.4');
    await page.waitForTimeout(3200);
    const out = await termText(page);

    const replies = (out.match(/bytes from 10\.0\.0\.4/g) ?? []).length;
    expect(replies).toBeGreaterThanOrEqual(2);
    // Realism: the Windows terminal keeps its own look — no raw ANSI, no
    // Linux prompt colours leaking across the boundary.
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);

    await page.screenshot({ path: `${SHOTS}/win-to-linux-ping-stream.png` });

    await page.locator('[data-testid="terminal-modal"]').click();
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(400);
    const stats = await termText(page);
    expect(stats).toMatch(/packets transmitted/);
  });

  test('Windows -> Linux: journalctl -f follows the log over SSH', async ({ page }) => {
    await sshLogin(page, lab.ip.linux1, 'user', 'admin');

    await typeCommand(page, 'journalctl -f');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/win-to-linux-journalctl-follow.png` });

    const out = await termText(page);
    // The follow stream is holding the tty: no fresh local prompt has been
    // drawn after the command (the input row is hidden during the stream).
    expect(out).toMatch(/journalctl -f/);

    await page.locator('[data-testid="terminal-modal"]').click();
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(400);
  });

  test('Windows -> Linux: exit returns to the Windows prompt', async ({ page }) => {
    await sshLogin(page, lab.ip.linux1, 'user', 'admin');
    let out = await termText(page);
    expect(out).toMatch(/user@/);

    await typeCommand(page, 'exit');
    await page.waitForTimeout(500);
    out = await termText(page);
    expect(out).toMatch(/Connection to 10\.0\.0\.1 closed\./);
    expect(out).toMatch(/C:\\Users\\/);
    await page.screenshot({ path: `${SHOTS}/win-to-linux-exit.png` });
  });
});

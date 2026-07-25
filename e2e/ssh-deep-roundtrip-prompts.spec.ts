import { test, expect, type Page } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand, typePassword,
  termText, TARGETS, type SshLab,
} from './helpers/sshLab';

/**
 * Deep SSH round trips crossed with the commands that own the terminal
 * for a turn: `sudo`, `su`, `Read-Host`, `Get-Credential`. Those are the
 * ones a broken hop shows up in first — the session looks fine until
 * something has to challenge the user for a value.
 */

const settle = (page: Page, ms = 900) => page.waitForTimeout(ms);

async function hop(page: Page, cmd: string, password: string, expected: RegExp): Promise<void> {
  await typeCommand(page, cmd);
  await settle(page, 800);
  await typePassword(page, password);
  await settle(page, 1100);
  expect(await termText(page), `hop \`${cmd}\` should land on ${expected}`).toMatch(expected);
}

/** Run a command that challenges for one value, then answer it. */
async function challenge(page: Page, cmd: string, answer: string): Promise<string> {
  const before = (await termText(page)).length;
  await typeCommand(page, cmd);
  await settle(page);
  await typePassword(page, answer);
  await settle(page);
  return (await termText(page)).slice(before);
}

test.describe('deep SSH round trips keep interactive prompts working', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
  });

  test('six alternating hops, then sudo su still challenges and elevates', async ({ page }) => {
    await hop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin', /user@PC2/);
    await hop(page, `ssh carl@${TARGETS.win1.ip}`, 'carl', /C:\\Users\\carl>/);
    await hop(page, `ssh user@${lab.ip.linux1}`, 'admin', /user@PC1/);
    await hop(page, `ssh carl@${TARGETS.win1.ip}`, 'carl', /C:\\Users\\carl>/);
    await hop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin', /user@PC2/);
    await hop(page, `ssh user@${lab.ip.linux1}`, 'admin', /user@PC1/);

    const out = await challenge(page, 'sudo su', 'admin');
    await typeCommand(page, 'whoami');
    await settle(page);
    expect(await termText(page), 'sudo su must still elevate six hops deep').toMatch(/\broot\b/);
    expect(out).not.toMatch(/command not found|not recognized/i);
  });

  test('su - at depth challenges for a password and switches user', async ({ page }) => {
    await hop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin', /user@PC2/);
    await hop(page, `ssh carl@${TARGETS.win1.ip}`, 'carl', /C:\\Users\\carl>/);
    await hop(page, `ssh user@${lab.ip.linux1}`, 'admin', /user@PC1/);

    await challenge(page, 'su', 'admin');
    await typeCommand(page, 'whoami');
    await settle(page);
    expect(await termText(page)).toMatch(/\broot\b/);
  });

  test('Read-Host on a PowerShell frame reached through two hops', async ({ page }) => {
    await hop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin', /user@PC2/);
    await hop(page, `ssh carl@${TARGETS.win1.ip}`, 'carl', /C:\\Users\\carl>/);

    await typeCommand(page, 'powershell');
    await settle(page);
    expect(await termText(page)).toMatch(/PS [A-Z]:\\/);

    const before = (await termText(page)).length;
    await typeCommand(page, '$name = Read-Host "Your name"');
    await settle(page);
    await typeCommand(page, 'ada');
    await settle(page);
    await typeCommand(page, 'Write-Output $name');
    await settle(page);
    expect((await termText(page)).slice(before)).toContain('ada');
  });

  /**
   * Separate gap, not an SSH one: `Get-Credential` returns nothing and
   * raises no challenge even on a local PowerShell frame, so there is no
   * interactive behaviour for a hop to inherit yet. Measured directly on
   * the device's own shell stack, with no wire involved.
   */
  test.fixme('Get-Credential on a PowerShell frame reached through two hops', async ({ page }) => {
    await hop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin', /user@PC2/);
    await hop(page, `ssh carl@${TARGETS.win1.ip}`, 'carl', /C:\\Users\\carl>/);

    await typeCommand(page, 'powershell');
    await settle(page);

    const before = (await termText(page)).length;
    await typeCommand(page, '$c = Get-Credential');
    await settle(page);
    await typeCommand(page, 'carl');
    await settle(page);
    await typePassword(page, 'carl');
    await settle(page);
    await typeCommand(page, '$c.UserName');
    await settle(page);
    expect((await termText(page)).slice(before)).toContain('carl');
  });

  test('unwinding six hops returns to the original local prompt', async ({ page }) => {
    await hop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin', /user@PC2/);
    await hop(page, `ssh carl@${TARGETS.win1.ip}`, 'carl', /C:\\Users\\carl>/);
    await hop(page, `ssh user@${lab.ip.linux1}`, 'admin', /user@PC1/);
    await hop(page, `ssh carl@${TARGETS.win1.ip}`, 'carl', /C:\\Users\\carl>/);
    await hop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin', /user@PC2/);
    await hop(page, `ssh user@${lab.ip.linux1}`, 'admin', /user@PC1/);

    for (let i = 0; i < 6; i++) {
      await typeCommand(page, 'exit');
      await settle(page, 700);
    }
    await typeCommand(page, 'hostname');
    await settle(page);
    expect(await termText(page), 'six exits should land back on the origin').toMatch(/PC1/);
  });
});

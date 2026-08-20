import { test, expect } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand, typePassword,
  termText, TARGETS, type SshLab,
} from './helpers/sshLab';

test.describe('sudo su after an SSH round trip (user report)', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
  });

  test('sudo su prompts and elevates on a fresh local terminal', async ({ page }) => {
    await typeCommand(page, 'sudo su');
    await page.waitForTimeout(600);
    await typePassword(page, 'admin');
    await page.waitForTimeout(600);
    await typeCommand(page, 'whoami');
    await page.waitForTimeout(600);
    expect(await termText(page)).toMatch(/\broot\b/);
  });

  test('sudo su still prompts and elevates after ssh to Windows and back', async ({ page }) => {
    await typeCommand(page, `ssh carl@${TARGETS.win1.ip}`);
    await page.waitForTimeout(800);
    await typePassword(page, 'carl');
    await page.waitForTimeout(1000);
    expect(await termText(page), 'we should be on the Windows prompt').toMatch(/C:\\Users\\carl>/);

    await typeCommand(page, 'exit');
    await page.waitForTimeout(1000);

    const before = (await termText(page)).length;
    await typeCommand(page, 'sudo su');
    await page.waitForTimeout(800);
    await typePassword(page, 'admin');
    await page.waitForTimeout(800);
    await typeCommand(page, 'whoami');
    await page.waitForTimeout(800);
    expect((await termText(page)).slice(before)).toMatch(/\broot\b/);
  });
});

test.describe('sudo su on a Linux box reached through a Windows hop', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
  });

  test('linux -> windows -> linux, then sudo su', async ({ page }) => {
    await typeCommand(page, `ssh carl@${TARGETS.win1.ip}`);
    await page.waitForTimeout(800);
    await typePassword(page, 'carl');
    await page.waitForTimeout(1000);
    expect(await termText(page)).toMatch(/C:\\Users\\carl>/);

    await typeCommand(page, `ssh user@${TARGETS.linux2.ip}`);
    await page.waitForTimeout(800);
    await typePassword(page, 'admin');
    await page.waitForTimeout(1200);
    expect(await termText(page), 'second hop should land on linux2').toMatch(/user@PC2/);

    const before = (await termText(page)).length;
    await typeCommand(page, 'sudo su');
    await page.waitForTimeout(900);
    await typePassword(page, 'admin');
    await page.waitForTimeout(900);
    await typeCommand(page, 'whoami');
    await page.waitForTimeout(900);
    expect((await termText(page)).slice(before)).toMatch(/\broot\b/);
  });
});

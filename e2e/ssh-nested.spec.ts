import { test, expect } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand,
  termText, sshHop, TARGETS, type SshLab,
} from './helpers/sshLab';

test.describe('Nested SSH (ssh in ssh in ssh in ssh)', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
  });

  test('4-deep all-vendor chain: Linux → Linux → Windows → Cisco → Huawei', async ({ page }) => {
    const h1 = await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin');
    expect(h1, 'hop 1 should land on linux2').toMatch(/user@PC2:~\$/);

    const h2 = await sshHop(page, `ssh carl@${TARGETS.win1.ip}`, 'carl');
    expect(h2, 'hop 2 (linux2 → windows) should land on the cmd prompt').toMatch(/C:\\Users\\carl>/);

    const h3 = await sshHop(page, `ssh admin@${TARGETS.ciscoR1.ip}`, 'Admin@123');
    expect(h3, 'hop 3 (windows → cisco) should land on ciscoR1#').toMatch(/ciscoR1#/);

    const h4 = await sshHop(page, `ssh -l admin ${TARGETS.hwR1.ip}`, 'Admin@123');
    expect(h4, 'hop 4 (cisco → huawei) should land on <hwR1>').toMatch(/<hwR1>/);
  });

  test('4-deep Linux nesting reflects each remote hostname in turn', async ({ page }) => {
    const h1 = await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin');
    expect(h1).toMatch(/user@PC2:~\$/);
    const h2 = await sshHop(page, `ssh user@${lab.ip.linux1}`, 'admin');
    expect(h2).toMatch(/user@PC1:~\$/);
    const h3 = await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin');
    expect(h3).toMatch(/user@PC2:~\$/);
    const h4 = await sshHop(page, `ssh user@${lab.ip.linux1}`, 'admin');
    expect(h4).toMatch(/user@PC1:~\$/);
  });

  test('nested hop preserves remote command execution at depth 2', async ({ page }) => {
    await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin');
    await sshHop(page, `ssh carl@${TARGETS.win1.ip}`, 'carl');
    const before = (await termText(page)).length;
    await typeCommand(page, 'hostname');
    await page.waitForTimeout(700);
    const out = (await termText(page)).slice(before);
    expect(out).toMatch(/PC3|WIN|win1/i);
  });

  test('exit unwinds one SSH level at a time back to the origin', async ({ page }) => {
    await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin');
    await sshHop(page, `ssh carl@${TARGETS.win1.ip}`, 'carl');

    await typeCommand(page, 'exit');
    await page.waitForTimeout(800);
    expect(await termText(page), 'after one exit we should be back on linux2').toMatch(/user@PC2:~\$/);

    await typeCommand(page, 'exit');
    await page.waitForTimeout(800);
    expect(await termText(page), 'after two exits we should be back on linux1').toMatch(/user@PC1:~\$/);
  });

  test('Cisco can SSH outbound to Huawei from within a session (jump host)', async ({ page }) => {
    await sshHop(page, `ssh admin@${TARGETS.ciscoR1.ip}`, 'Admin@123');
    const out = await sshHop(page, `ssh -l admin ${TARGETS.hwR1.ip}`, 'Admin@123');
    expect(out).toMatch(/<hwR1>/);
  });
});

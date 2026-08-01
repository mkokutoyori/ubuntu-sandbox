/**
 * F7.11 — deleting a log file while rsyslog is writing to it
 * (docs/PRD-Pannes.md §F7.11).
 *
 * This is the classic trap, and the reason it is worth simulating at all:
 * the obvious mental model — "the file is gone, so the next line recreates
 * it" — is wrong, and being wrong about it is what makes the incident so
 * confusing in the field. A daemon writes through a file DESCRIPTOR. `rm`
 * removes the NAME; the inode survives because rsyslog still holds it, so
 * every subsequent line lands somewhere no path leads to, the disk space is
 * never freed, and `ls` shows nothing while `df` shows a full disk.
 *
 * Only reopening the file by name — `systemctl restart rsyslog`, or what
 * logrotate's postrotate `kill -HUP` does — brings it back. `touch` does
 * not: it creates a NEW inode that the daemon is not writing to.
 *
 * The tests below assert the trap itself, not just the end state, because
 * the intermediate observations (journal still complete, `lsof` showing
 * `(deleted)`) are the ones that let an operator diagnose it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

function pc(): LinuxPC {
  return new LinuxPC('linux-pc', 'PC1');
}

const run = (d: LinuxPC, cmd: string) => d.executeCommand(cmd);

describe('F7.11 — a log file deleted under the running daemon', () => {
  it('nominal: a logged line lands in the file', async () => {
    const d = pc();
    await run(d, 'logger -t essai "ligne-temoin"');

    expect(await run(d, 'tail -n 5 /var/log/syslog')).toContain('ligne-temoin');
  });

  it('after `rm`, the next line does NOT recreate the file', async () => {
    const d = pc();
    await run(d, 'logger -t essai "avant"');
    await run(d, 'sudo rm /var/log/syslog');

    await run(d, 'logger -t essai "apres"');

    // The write succeeded — rsyslog has no way to notice — but it went to
    // the unlinked inode. This single assertion is the whole scenario.
    expect(await run(d, 'ls -l /var/log/syslog')).toContain('No such file or directory');
  });

  it('the lines written meanwhile are lost from the file, not buffered', async () => {
    const d = pc();
    await run(d, 'sudo rm /var/log/syslog');
    await run(d, 'logger -t essai "dans-le-vide"');
    await run(d, 'sudo systemctl restart rsyslog');

    // Restarting reopens the path, but what was written into the dead
    // inode does not come back with it — that is what "lost" means.
    expect(await run(d, 'cat /var/log/syslog')).not.toContain('dans-le-vide');
  });

  it('the journal keeps everything — journald is not rsyslog', async () => {
    const d = pc();
    await run(d, 'sudo rm /var/log/syslog');
    await run(d, 'logger -t essai "dans-le-vide"');

    // journald holds its own in-memory journal and never went through the
    // deleted file, so `journalctl` is how you recover what /var/log lost.
    expect(await run(d, 'journalctl -n 20')).toContain('dans-le-vide');
  });

  it('`lsof` shows the deleted file still held open — where the disk went', async () => {
    const d = pc();
    await run(d, 'sudo rm /var/log/syslog');
    await run(d, 'logger -t essai "dans-le-vide"');

    const out = await run(d, 'lsof');
    expect(out).toContain('/var/log/syslog (deleted)');
    // Named against the daemon that holds it, so the operator knows what to
    // restart rather than guessing.
    expect(out).toMatch(/rsyslogd/);
  });

  it('nothing is reported deleted while the file is simply present', async () => {
    const d = pc();
    await run(d, 'logger -t essai "normal"');

    expect(await run(d, 'lsof')).not.toContain('(deleted)');
  });

  it('restarting rsyslog reopens by name and logging resumes', async () => {
    const d = pc();
    await run(d, 'sudo rm /var/log/syslog');
    await run(d, 'logger -t essai "dans-le-vide"');
    expect(await run(d, 'ls -l /var/log/syslog')).toContain('No such file');

    await run(d, 'sudo systemctl restart rsyslog');
    await run(d, 'logger -t essai "apres-restart"');

    expect(await run(d, 'cat /var/log/syslog')).toContain('apres-restart');
  });

  it('and the deleted handle is released — no residue after the repair', async () => {
    const d = pc();
    await run(d, 'sudo rm /var/log/syslog');
    await run(d, 'logger -t essai "dans-le-vide"');
    expect(await run(d, 'lsof')).toContain('(deleted)');

    await run(d, 'sudo systemctl restart rsyslog');

    // The inode is finally freed: this is the moment `df` recovers.
    expect(await run(d, 'lsof')).not.toContain('(deleted)');
  });

  it('a log file that never existed is created on first write, as normal', async () => {
    const d = pc();

    // The trap is specifically about an OPEN file being unlinked. A daemon
    // opening a path for the first time really does create it, and breaking
    // that would break ordinary logging.
    await run(d, 'logger -t essai "premiere-ligne"');

    expect(await run(d, 'tail -n 5 /var/log/syslog')).toContain('premiere-ligne');
  });
});

/*
 * Probe — `systemctl is-active|is-enabled|is-failed` answer for EVERY unit
 * named, one line each, and succeed when at least one matches.
 *
 * Before: only the first operand was read. On the user's lab,
 * `systemctl is-active nginx ssh vsftpd` on Server1 printed a single
 * "active", and with nginx stopped `systemctl is-active nginx ssh` printed
 * "active" too: the answer for ssh, shown as the only line.
 *
 * Authority: systemctl(1), is-active PATTERN…: "Check whether any of the
 * specified units are active (i.e. running). Returns an exit code 0 if at
 * least one is active, or non-zero otherwise. Unless --quiet is specified,
 * this will also print the current unit state to standard output."
 * is-failed and is-enabled are worded the same way ("at least one").
 *
 * Measured before the change (git stash of src/network/devices/linux):
 * 6 of the 7 cases fail (`-q` before the verb was even taken for a
 * listing request).
 * Passing either way:
 *   - "a single active unit" is the WITNESS.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

async function server(): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  srv.powerOn();
  await srv.executeCommand('systemctl start ssh');
  await srv.executeCommand('systemctl stop nginx');
  return srv;
}

describe('systemctl is-* reads every unit', () => {
  it('a single active unit', async () => {
    const srv = await server();
    expect(await srv.executeCommand('systemctl is-active ssh; echo EC=$?')).toBe('active\nEC=0');
  });

  it('is-active prints one state per unit, in order', async () => {
    const srv = await server();
    expect(await srv.executeCommand('systemctl is-active nginx ssh; echo EC=$?')).toBe('inactive\nactive\nEC=0');
  });

  it('is-active fails with 3 when none is active', async () => {
    const srv = await server();
    expect(await srv.executeCommand('systemctl is-active ssh-not-installed nginx; echo EC=$?')).toBe('inactive\ninactive\nEC=3');
  });

  it('--quiet prints nothing and keeps the verdict', async () => {
    const srv = await server();
    expect(await srv.executeCommand('systemctl is-active --quiet nginx ssh; echo EC=$?')).toBe('EC=0');
  });

  it('-q is --quiet', async () => {
    const srv = await server();
    expect(await srv.executeCommand('systemctl -q is-active nginx; echo EC=$?')).toBe('EC=3');
  });

  it('is-enabled prints one state per unit', async () => {
    const srv = await server();
    await srv.executeCommand('systemctl disable nginx');
    await srv.executeCommand('systemctl enable ssh');
    expect(await srv.executeCommand('systemctl is-enabled nginx ssh; echo EC=$?')).toBe('disabled\nenabled\nEC=0');
  });

  it('is-failed prints one state per unit', async () => {
    const srv = await server();
    expect(await srv.executeCommand('systemctl is-failed nginx ssh; echo EC=$?')).toBe('inactive\nactive\nEC=1');
  });
});

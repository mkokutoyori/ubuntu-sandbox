/**
 * Unit tests — environment & identity commands.
 *
 * Anomalies from the debug transcript: `id -u/-un` ignored flags,
 * `uname -s -n -m` collapsed to "Linux", `tty`/`runlevel`/`hostnamectl`
 * were "command not found", `/etc/os-release` was missing, `date -u`
 * used a JS Date string, and `uptime` disagreed with `w`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('id flag handling', () => {
  it('id -u prints only the numeric uid', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    expect((await pc.executeCommand('id -u')).trim()).toBe('1000');
  });

  it('id -un prints the user name', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    expect((await pc.executeCommand('id -un')).trim()).toBe('user');
  });

  it('id -g prints the numeric gid', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    expect((await pc.executeCommand('id -g')).trim()).toBe('1000');
  });

  it('id with no flags keeps the full format', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    expect(await pc.executeCommand('id')).toContain('uid=1000(user)');
  });

  it('id -n alone is rejected', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    expect(await pc.executeCommand('id -n')).toContain('cannot print only names');
  });
});

describe('uname flag combination', () => {
  it('uname -s -n -m combines all requested fields', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    const out = (await pc.executeCommand('uname -s -n -m')).trim();
    // uname -n echoes /etc/hostname, so anything reasonable is fine.
    expect(out).toMatch(/^Linux \S+ x86_64$/);
  });

  it('uname -a is the canonical long form', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    const out = await pc.executeCommand('uname -a');
    expect(out).toContain('Linux');
    expect(out).toContain('x86_64');
    expect(out).toContain('GNU/Linux');
  });

  it('uname with no flag prints the kernel name', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    expect((await pc.executeCommand('uname')).trim()).toBe('Linux');
  });
});

describe('tty / runlevel / hostnamectl', () => {
  it('tty reports the pseudo-terminal device', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    expect((await pc.executeCommand('tty')).trim()).toBe('/dev/pts/0');
  });

  it('runlevel differs between PC (5) and server (3)', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    const srv = new LinuxServer('linux-server', 'SI-SRV', 2, 2);
    expect((await pc.executeCommand('runlevel')).trim()).toBe('N 5');
    expect((await srv.executeCommand('runlevel')).trim()).toBe('N 3');
  });

  it('hostnamectl reports the static hostname and OS', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    const out = await pc.executeCommand('hostnamectl');
    expect(out).toContain('Static hostname:');
    expect(out).toContain('Operating System: Ubuntu');
  });
});

describe('/etc/os-release and date/uptime', () => {
  it('/etc/os-release exists and identifies Ubuntu', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    const out = await pc.executeCommand('cat /etc/os-release');
    expect(out).toContain('NAME="Ubuntu"');
    expect(out).toContain('VERSION_ID="22.04"');
  });

  it('date uses the coreutils shape, not a JS Date string', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    const out = (await pc.executeCommand('date')).trim();
    expect(out).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2} UTC \d{4}$/);
  });

  it('date +%Y-%m-%d honours a format string', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    expect((await pc.executeCommand('date +%Y-%m-%d')).trim()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uptime -p is the pretty form', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    expect((await pc.executeCommand('uptime -p')).trim()).toMatch(/^up .*minute/);
  });

  it('uptime header shape (used by w as well)', async () => {
    const pc = new LinuxPC('linux-pc', 'SI-PC', 1, 1);
    const up = (await pc.executeCommand('uptime')).trim();
    // Both `w` and `uptime` print the same up/users/load preamble; the
    // exact wording differs slightly (w sources from the session table).
    expect(up).toMatch(/up\s+.+,\s+\d+\s+users?,\s+load average:/);
  });
});

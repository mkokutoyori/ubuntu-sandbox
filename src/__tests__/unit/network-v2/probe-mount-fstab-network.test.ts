/*
 * Probe: mount reads /etc/fstab. `mount /backup` (one operand, the usual way to mount a line of fstab) answered "mount: /backup: can't find in /etc/fstab"
 * whatever the file held, and `mount -a` added a mount-table entry for an nfs line WITHOUT contacting the server (no MOUNT protocol on the wire, no file handle:
 * what was written under the mount point stayed on the client disk). util-linux mount(8): with only one of directory or device given, the other and the
 * options come from fstab; -a mounts every line of fstab that is not noauto and not already mounted; `defaults` is the empty option set. The three forms now go
 * through the one routine the explicit `mount -t nfs server:/export /dir` already used (MOUNT over the wire, NFS file handle, export access check), so a file
 * written under the mount point is on the server's disk whichever form mounted it. Lines marked noauto are skipped by -a and mountable by name.
 *
 * Discriminated with git stash on src: 4 of 6 fall before the fix; the witness (the explicit form) and the refusal of an unknown operand pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset();
  lab = await buildRmanLab();
  lab.sh(lab.dr, 'mkdir -p /srv/backup');
  lab.sh(lab.dr, `sh -c 'echo "/srv/backup 10.10.10.0/24(rw,sync,no_root_squash)" > /etc/exports'`);
  lab.sh(lab.dr, 'systemctl start rpcbind');
  lab.sh(lab.dr, 'systemctl start nfs-kernel-server');
  lab.sh(lab.prod, 'mkdir -p /backup /archive');
});

const fstab = (...lines: string[]) => lab.sh(lab.prod, `sh -c 'printf "${lines.join('\\n')}\\n" > /etc/fstab'`);
const LINE = '10.10.20.20:/srv/backup /backup nfs defaults 0 0';

describe('mount and /etc/fstab', () => {
  it('witness: the explicit form mounts the export and writes reach the server', () => {
    lab.sh(lab.prod, 'mount -t nfs 10.10.20.20:/srv/backup /backup');
    lab.sh(lab.prod, `sh -c 'echo A > /backup/a.txt'`);
    expect(lab.sh(lab.dr, 'cat /srv/backup/a.txt')).toContain('A');
  });

  it('mount <directory> takes the device, the type and the options from fstab', () => {
    fstab(LINE);
    expect(lab.sh(lab.prod, `sh -c 'mount /backup; echo rc=$?'`)).toContain('rc=0');
    lab.sh(lab.prod, `sh -c 'echo B > /backup/b.txt'`);
    expect(lab.sh(lab.dr, 'cat /srv/backup/b.txt')).toContain('B');
  });

  it('mount <device> finds its line too', () => {
    fstab(LINE);
    lab.sh(lab.prod, 'mount 10.10.20.20:/srv/backup');
    expect(lab.sh(lab.prod, 'mount')).toContain('10.10.20.20:/srv/backup on /backup type nfs');
  });

  it('mount -a mounts over the wire: a file written under the mount point is on the server', () => {
    fstab(LINE);
    lab.sh(lab.prod, 'mount -a');
    lab.sh(lab.prod, `sh -c 'echo C > /backup/c.txt'`);
    expect(lab.sh(lab.dr, 'cat /srv/backup/c.txt')).toContain('C');
  });

  it('a noauto line is skipped by -a and mounted when named; an ro option is honoured', () => {
    fstab('10.10.20.20:/srv/backup /archive nfs ro,noauto 0 0');
    lab.sh(lab.prod, 'mount -a');
    expect(lab.sh(lab.prod, 'mount')).not.toContain('/archive');
    lab.sh(lab.prod, 'mount /archive');
    expect(lab.sh(lab.prod, 'mount')).toContain('/archive');
    expect(lab.sh(lab.prod, `sh -c 'echo D > /archive/d.txt; echo rc=$?'`)).not.toContain('rc=0');
  });

  it('an operand fstab does not list is still refused in the words of mount', () => {
    fstab(LINE);
    expect(lab.sh(lab.prod, 'mount /nosuch')).toContain("mount: /nosuch: can't find in /etc/fstab.");
  });
});

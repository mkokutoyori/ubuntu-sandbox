/*
 * Probe: measured on the e-commerce lab, on a directory mounted over NFS `ls` listed the files but `echo /mnt/x/*` and `cp /mnt/x/* dest/` found nothing to
 * expand ("cannot stat"), `find /mnt/x -type f` printed nothing (it walked the local mount point, which is empty), and `cp` from or to the mount created a
 * zero-byte file: it read the inode content of a remote file (always empty) and created the target in the local tree under the mount. Those three readers
 * went to the local inode tree while RemoteMountPort already answers list, stat, read and write. The glob lists the directory through the port, find walks
 * the port, cp reads through readFile and creates through the port. Sources: bash(1) pathname expansion, find(1), cp(1); the wire is NFSv3 (RFC 1813).
 *
 * Discriminated with git stash on src: 4 of 6 fall before the fix; the witness (ls through the mount) and the two non-regressions (glob and find on a purely
 * local directory) pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

const EXPORT_PATH = '/srv/backup';
const MOUNT_POINT = '/mnt/backup_nfs';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset();
  lab = await buildRmanLab();
  lab.sh(lab.dr, `mkdir -p ${EXPORT_PATH}`);
  lab.sh(lab.dr, `chmod 777 ${EXPORT_PATH}`);
  lab.sh(lab.dr, `sh -c 'echo "${EXPORT_PATH} 10.10.10.0/24(rw,sync,no_root_squash)" > /etc/exports'`);
  lab.sh(lab.dr, 'systemctl start rpcbind');
  lab.sh(lab.dr, 'systemctl start nfs-kernel-server');
  lab.sh(lab.dr, `sh -c 'echo piece-one > ${EXPORT_PATH}/a.bkp; echo piece-two > ${EXPORT_PATH}/b.bkp'`);
  lab.sh(lab.prod, `mkdir -p ${MOUNT_POINT}`);
  lab.sh(lab.prod, `mount -t nfs ${lab.drIp}:${EXPORT_PATH} ${MOUNT_POINT}`);
});

describe('glob, find and cp see the files of a network mount', () => {
  it('witness: ls lists the files of the mount', () => {
    expect(lab.sh(lab.prod, `ls ${MOUNT_POINT}`)).toContain('a.bkp');
  });

  it('a glob expands to the files of the mount', () => {
    const expanded = lab.sh(lab.prod, `echo ${MOUNT_POINT}/*.bkp`);
    expect(expanded).toContain(`${MOUNT_POINT}/a.bkp`);
    expect(expanded).toContain(`${MOUNT_POINT}/b.bkp`);
  });

  it('find walks the mount', () => {
    const found = lab.sh(lab.prod, `find ${MOUNT_POINT} -type f -name '*.bkp'`);
    expect(found).toContain(`${MOUNT_POINT}/a.bkp`);
    expect(found).toContain(`${MOUNT_POINT}/b.bkp`);
  });

  it('cp from the mount to a local directory carries the bytes', () => {
    lab.sh(lab.prod, 'mkdir -p /tmp/local');
    lab.sh(lab.prod, `cp ${MOUNT_POINT}/*.bkp /tmp/local/`);
    expect(lab.sh(lab.prod, 'cat /tmp/local/a.bkp')).toContain('piece-one');
    expect(lab.sh(lab.prod, 'cat /tmp/local/b.bkp')).toContain('piece-two');
  });

  it('cp from a local file to the mount writes it on the server', () => {
    lab.sh(lab.prod, "sh -c 'echo shipped > /tmp/out.bkp'");
    lab.sh(lab.prod, `cp /tmp/out.bkp ${MOUNT_POINT}/out.bkp`);
    expect(lab.sh(lab.dr, `cat ${EXPORT_PATH}/out.bkp`)).toContain('shipped');
  });

  it('non-regression: a glob and find on a local directory still work', () => {
    lab.sh(lab.prod, "sh -c 'mkdir -p /tmp/plain; echo x > /tmp/plain/p.bkp'");
    expect(lab.sh(lab.prod, 'echo /tmp/plain/*.bkp')).toContain('/tmp/plain/p.bkp');
    expect(lab.sh(lab.prod, "find /tmp/plain -type f -name '*.bkp'")).toContain('/tmp/plain/p.bkp');
  });
});

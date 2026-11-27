/*
 * Probe: measured on the e-commerce lab with an NFS export mounted from the backup server. (1) `touch /mnt/backup_nfs/f` failed (touch only knew the local inode
 * tree and answered No such file or directory under a network mount) while `echo > f` worked; (2) every file or directory created by an unprivileged user through
 * the mount belonged to uid 0 on the server, because the client sent a fixed AUTH_SYS identity and the mounted file system dropped the caller's uid/gid (`void uid`).
 * RFC 5531 section 8.1 (AUTH_SYS): the credential carries the caller's uid and gid and the server creates the object with them; Linux nfs client does the same.
 * The client now acts as the caller for create, write and mkdir.
 *
 * Discriminated with git stash on src: 3 of 5 fall before the fix; the witness (root writing through the mount) and the two root-owned cases pass either way: the
 * witness proves the lab and the export are sound, the others are non-regressions (root keeps uid 0 under no_root_squash).
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
  lab.sh(lab.prod, `mkdir -p ${MOUNT_POINT}`);
  lab.sh(lab.prod, `mount -t nfs ${lab.drIp}:${EXPORT_PATH} ${MOUNT_POINT}`);
});

const owner = (path: string) => lab.sh(lab.dr, `stat -c '%u:%g' ${path}`).trim();
const oracleUid = () => lab.sh(lab.prod, 'id -u oracle').trim();

describe('the client acts as the caller on a network mount', () => {
  it('witness: root writing through the mount creates a root-owned file on the server', () => {
    lab.sh(lab.prod, `sh -c 'echo x > ${MOUNT_POINT}/root.txt'`);
    expect(owner(`${EXPORT_PATH}/root.txt`)).toBe('0:0');
  });

  it('touch creates the file on the server', () => {
    lab.sh(lab.prod, `touch ${MOUNT_POINT}/t.txt`);
    expect(lab.sh(lab.dr, `ls ${EXPORT_PATH}`)).toContain('t.txt');
  });

  it('a file written by oracle is owned by oracle on the server', () => {
    lab.sh(lab.prod, `su oracle -c "sh -c 'echo x > ${MOUNT_POINT}/o.txt'"`);
    expect(owner(`${EXPORT_PATH}/o.txt`).split(':')[0]).toBe(oracleUid());
  });

  it('a directory created by oracle is owned by oracle on the server', () => {
    lab.sh(lab.prod, `su oracle -c "mkdir ${MOUNT_POINT}/d"`);
    expect(owner(`${EXPORT_PATH}/d`).split(':')[0]).toBe(oracleUid());
  });

  it('touch on an existing file keeps its content', () => {
    lab.sh(lab.prod, `sh -c 'echo keep > ${MOUNT_POINT}/k.txt'`);
    lab.sh(lab.prod, `touch ${MOUNT_POINT}/k.txt`);
    expect(lab.sh(lab.dr, `cat ${EXPORT_PATH}/k.txt`)).toContain('keep');
  });
});

/*
 * Probe: measured on the e-commerce lab, RESTORE DATABASE worked from backup pieces on the NFS volume but RECOVER failed with RMAN-06025 "no backup of archived log
 * ... found to restore" for a log that was in the piece: the piece read back from the mount was not the piece written (client cat and server md5sum differed for
 * the same size). The mount converted text to bytes with a one-char-one-byte rule, which keeps the low byte of a character above U+00FF (the em dash U+2014 became
 * U+0014, a control character that makes the JSON image unparseable). The mount now encodes a text holding such a character in UTF-8 and decodes what is valid
 * UTF-8, falling back to the byte-per-char reading for the rest, so plain ASCII and Latin-1 text keep their bytes.
 *
 * Discriminated with git stash on src: 2 of 4 fall before the fix; the witness (ASCII) and the Latin-1 case pass either way: they are the non-regression of the
 * fallback.
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

const roundTrip = (text: string) => {
  lab.sh(lab.prod, `printf '%s' '${text}' > ${MOUNT_POINT}/t.txt`);
  return lab.sh(lab.prod, `cat ${MOUNT_POINT}/t.txt`);
};

describe('a text written to a network mount is read back unchanged', () => {
  it('witness: ASCII', () => {
    expect(roundTrip('plain text 123')).toBe('plain text 123');
  });

  it('Latin-1 text keeps its characters', () => {
    expect(roundTrip('piece de rechange: café')).toBe('piece de rechange: café');
  });

  it('text with a character above U+00FF keeps it', () => {
    expect(roundTrip('niveau 0 — dimanche')).toBe('niveau 0 — dimanche');
  });

  it('a JSON line with such a character stays parseable after the trip', () => {
    const back = roundTrip('{"name":"archive — sequence 1","ok":true}');
    expect(JSON.parse(back)).toEqual({ name: 'archive — sequence 1', ok: true });
  });
});

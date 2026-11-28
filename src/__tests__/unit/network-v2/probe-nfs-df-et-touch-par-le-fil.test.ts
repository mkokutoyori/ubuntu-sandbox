/*
 * Sonde — `df` et `touch` sur un montage NFS passent par le fil (FSSTAT et SETATTR).
 *
 * Releve AVANT, sur le laboratoire RMAN (ORA-PRD monte l'export du site de reprise) :
 *
 *   df -h /mnt/backup_nfs     Filesystem  Size  Used  Avail  Use%   ->  des zeros
 *   touch /mnt/backup_nfs/a.bkp                                     ->  la date du fichier ne bouge pas
 *
 * `df` lisait la table de montage et les partitions locales : un montage reseau n'a aucune partition locale, donc 0. Le serveur NFS sait pourtant repondre
 * (procedure 18 FSSTAT, RFC 1813 §3.3.18 : espace total, libre, disponible, inodes) et il avait une methode `spaceTotals()` que personne n'appelait cote client.
 * `touch` sur un fichier distant existant rendait vrai sans rien envoyer ; la procedure 2 SETATTR avec SET_TO_SERVER_TIME (RFC 1813 §3.3.2) met a jour atime et mtime.
 *
 * Discrimine par `git stash push -- src/network` : 3 des 4 cas tombent (la taille, l'occupation qui suit une ecriture, la date). Le TEMOIN (un montage local ne change pas
 * de comportement : la racine garde sa taille) passe des deux cotes.
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
  lab.sh(lab.dr, `sh -c 'echo piece-one > ${EXPORT_PATH}/a.bkp'`);
  lab.sh(lab.prod, `mkdir -p ${MOUNT_POINT}`);
  lab.sh(lab.prod, `mount -t nfs ${lab.drIp}:${EXPORT_PATH} ${MOUNT_POINT}`);
});

const dfRow = (path: string): string[] =>
  (lab.sh(lab.prod, `df -k ${path}`).split('\n')[1] ?? '').trim().split(/\s+/);

describe('df et touch sur un montage reseau', () => {
  it('TEMOIN — la racine locale garde une taille', () => {
    expect(Number(dfRow('/')[1])).toBeGreaterThan(0);
  });

  it('df annonce la taille du volume exporte, celle que le serveur donne', () => {
    const row = dfRow(MOUNT_POINT);
    expect(row[0]).toContain(`${lab.drIp}:${EXPORT_PATH}`);
    expect(Number(row[1])).toBeGreaterThan(0);
    expect(Number(row[3])).toBeGreaterThan(0);
  });

  it('l occupation suit ce qu on ecrit sur le serveur', () => {
    const before = Number(dfRow(MOUNT_POINT)[2]);
    lab.sh(lab.dr, `sh -c 'head -c 600000 /dev/zero > ${EXPORT_PATH}/big.bkp'`);
    expect(Number(dfRow(MOUNT_POINT)[2])).toBeGreaterThan(before);
  });

  it('touch sur un fichier distant qui existe met a jour sa date', () => {
    const date = () => lab.sh(lab.prod, `stat -c %Y ${MOUNT_POINT}/a.bkp`).trim();
    lab.sh(lab.dr, `touch -d '2020-01-01 00:00:00' ${EXPORT_PATH}/a.bkp`);
    const old = Number(date());
    lab.sh(lab.prod, `touch ${MOUNT_POINT}/a.bkp`);
    expect(Number(date())).toBeGreaterThan(old);
  });
});

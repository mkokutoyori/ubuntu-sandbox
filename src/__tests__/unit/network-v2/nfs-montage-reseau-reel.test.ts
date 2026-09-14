/**
 * Sonde — un montage reseau porte vraiment les octets chez le serveur.
 * Laboratoire routeur + pare-feu du lot RMAN.
 *
 *   ORA-PROD ── R-CORE (routeur) ── FGT-DC (pare-feu) ── ORA-DR
 *   10.10.10.10                                         10.10.20.20
 *
 * Releve AVANT, sur la machine telle qu'elle etait :
 *
 *   echo "/srv/backup 10.10.10.0/24(rw,sync)" > /etc/exports
 *   exportfs -a                        exportfs: command not found
 *   systemctl start nfs-kernel-server  Unit nfs-kernel-server.service not found.
 *   ss -ltn | grep -E "2049|20048"     (rien)
 *   showmount -e 10.10.20.20           showmount: command not found
 *   mount -t nfs 10.10.20.20:/srv/backup /mnt/backup_nfs ; echo rc=$?
 *                                      rc=0
 *   mount | grep nfs                   10.10.20.20:/srv/backup on /mnt/backup_nfs type nfs
 *
 *   echo PIECE-RMAN > /mnt/backup_nfs/test.bkp
 *     cote CLIENT                      PIECE-RMAN
 *     cote SERVEUR                     cat: /srv/backup/test.bkp: No such file or directory
 *     ls /srv/backup (serveur)         (vide)
 *
 *   BACKUP DATABASE FORMAT '/mnt/backup_nfs/%U'
 *     piece handle=                    /u01/.../fast_recovery_area/... (la FRA LOCALE)
 *     ls /srv/backup (serveur)         (vide)
 *
 * Le montage reussissait sans joindre personne, et TOUT ce qu'on ecrivait
 * dessous restait dans le VFS local sous un nom qui disait le contraire.
 * Deux machines affirmaient deux choses differentes du meme fichier au
 * meme instant. C'etait la derniere grande violation du §4 sur le chemin
 * de sauvegarde, et l'assessment RMAN la mesurait deja en [G]/[H].
 *
 * Ce que le lot pose : le protocole NFSv3 (commit precedent) branche sur
 * la machine. Le point etroit est `RemoteMountPort` dans le VFS, jumeau
 * de `setReadOnlyResolver` — le VFS ne connait pas le reseau, il connait
 * un port. C'est ce qui fait que `cat`, `echo >`, `ls`, `mv`, `rm` ET
 * l'ecriture de piece de RMAN traversent tous le fil sans qu'aucun
 * d'eux n'ait ete touche.
 *
 * Discrimination par `git stash push -- src/network src/terminal` :
 * 8 cas sur 10 tombent avant le correctif. Le protocole reste en place
 * pendant la mesure — seul le BRANCHEMENT est retire — donc ce qui tombe
 * mesure bien le branchement et non l'existence de NFS.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « root_squash fait vraiment tomber l'uid 0 sur l'anonyme » : il ne
 *    PEUT pas discriminer, et c'est instructif. Il verifie qu'un fichier
 *    refuse par le serveur n'apparait pas sur le disque du serveur ;
 *    avant le correctif rien n'y apparaissait jamais, donc il passait
 *    pour la mauvaise raison. Apres, il passe pour la bonne : l'ecriture
 *    part vraiment, le serveur la refuse vraiment. Il ne vaut que lu
 *    avec le cas d'a cote, ou l'ecriture arrive.
 *  - « un montage LOCAL reste local » : NON-REGRESSION. Le port distant
 *    ne doit couvrir QUE les chemins sous un montage reseau ; un
 *    `mount --bind` ou un montage de partition ne doit rien changer.
 *
 * (Une premiere redaction de cet en-tete annoncait 7 sur 9 et donnait le
 * temoin du pare-feu comme non discriminant. La mesure dit 8 sur 10, et
 * le temoin discrimine : avant, `mount` rendait rc=0 quoi qu'il arrive.)
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
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  resetAllOracleInstances();
  Logger.reset();
  lab = await buildRmanLab();
});

function serveExport(options = 'rw,sync,no_root_squash'): void {
  lab.sh(lab.dr, `mkdir -p ${EXPORT_PATH}`);
  lab.sh(lab.dr, `sh -c 'echo "${EXPORT_PATH} 10.10.10.0/24(${options})" > /etc/exports'`);
  lab.sh(lab.dr, 'systemctl start rpcbind');
  lab.sh(lab.dr, 'systemctl start nfs-kernel-server');
}

function mountOnClient(): string {
  lab.sh(lab.prod, `mkdir -p ${MOUNT_POINT}`);
  return lab.sh(lab.prod, `sh -c 'mount -t nfs ${lab.drIp}:${EXPORT_PATH} ${MOUNT_POINT}; echo rc=$?'`);
}

describe('le serveur publie vraiment ses exports', () => {
  it('exportfs rend la liste que /etc/exports declare, avec ses options', () => {
    serveExport();
    const listing = lab.sh(lab.dr, 'exportfs -v');
    expect(listing).toContain(EXPORT_PATH);
    expect(listing).toContain('10.10.10.0/24');
    expect(listing).toContain('rw');
    expect(listing).toContain('no_root_squash');
  });

  it('les trois demons ecoutent, et ss le dit', () => {
    serveExport();
    const sockets = lab.sh(lab.dr, 'ss -ltn');
    expect(sockets).toContain(':2049');
    expect(sockets).toContain(':20048');
    expect(sockets).toContain(':111');
  });

  it('showmount interroge le SERVEUR depuis le client', () => {
    serveExport();
    const answer = lab.sh(lab.prod, `showmount -e ${lab.drIp}`);
    expect(answer).toContain(`Export list for ${lab.drIp}`);
    expect(answer).toContain(EXPORT_PATH);
    expect(answer).toContain('10.10.10.0/24');
  });
});

describe('les octets ecrits sous le point de montage sont chez le serveur', () => {
  it('un fichier ecrit par le client existe sur le disque du serveur', () => {
    serveExport();
    expect(mountOnClient()).toContain('rc=0');

    lab.sh(lab.prod, `sh -c 'echo PIECE-RMAN > ${MOUNT_POINT}/test.bkp'`);
    expect(lab.sh(lab.dr, `cat ${EXPORT_PATH}/test.bkp`)).toContain('PIECE-RMAN');
    expect(lab.sh(lab.dr, `ls ${EXPORT_PATH}`)).toContain('test.bkp');
  });

  it('ce que le serveur ecrit, le client le lit par le meme chemin', () => {
    serveExport();
    mountOnClient();
    lab.sh(lab.dr, `sh -c 'echo DEPUIS-LE-SERVEUR > ${EXPORT_PATH}/retour.txt'`);
    expect(lab.sh(lab.prod, `cat ${MOUNT_POINT}/retour.txt`)).toContain('DEPUIS-LE-SERVEUR');
    expect(lab.sh(lab.prod, `ls ${MOUNT_POINT}`)).toContain('retour.txt');
  });

  it('une piece de sauvegarde RMAN atterrit sur le serveur de sauvegarde', () => {
    serveExport();
    mountOnClient();
    lab.sh(lab.dr, `chown -R oracle:oinstall ${EXPORT_PATH}`);

    const out = lab.sh(lab.prod,
      `printf "BACKUP DATABASE FORMAT '${MOUNT_POINT}/%%U';\\n" | rman target /`);
    expect(out).toContain('Finished backup');
    expect(out).toContain(`piece handle=${MOUNT_POINT}/`);

    const onServer = lab.sh(lab.dr, `ls ${EXPORT_PATH}`);
    expect(onServer).toMatch(/_1_1/);
  });
});

describe('les refus sont ceux du protocole, pas des silences', () => {
  it('monter un export inexistant est refuse au lieu de reussir', () => {
    serveExport();
    lab.sh(lab.prod, `mkdir -p ${MOUNT_POINT}`);
    const out = lab.sh(lab.prod,
      `sh -c 'mount -t nfs ${lab.drIp}:/srv/absent ${MOUNT_POINT}; echo rc=$?'`);
    expect(out).toContain('mount.nfs');
    expect(out).toContain('No such file or directory');
    expect(out).not.toContain('rc=0');
  });

  it('root_squash fait vraiment tomber l uid 0 sur l anonyme', () => {
    serveExport('rw,sync,root_squash');
    mountOnClient();
    lab.sh(lab.prod, `sh -c 'echo INTERDIT > ${MOUNT_POINT}/squash.bkp'`);
    expect(lab.sh(lab.dr, `ls ${EXPORT_PATH}`)).not.toContain('squash.bkp');
  });

  it('TEMOIN — pare-feu ferme, le montage ne se fait pas', async () => {
    serveExport();
    await lab.firewall.executeCommand('config firewall policy');
    await lab.firewall.executeCommand('edit 1');
    await lab.firewall.executeCommand('set action deny');
    await lab.firewall.executeCommand('next');
    await lab.firewall.executeCommand('end');

    lab.sh(lab.prod, `mkdir -p ${MOUNT_POINT}`);
    const out = lab.sh(lab.prod,
      `sh -c 'mount -t nfs ${lab.drIp}:${EXPORT_PATH} ${MOUNT_POINT}; echo rc=$?'`);
    expect(out).not.toContain('rc=0');
    expect(lab.sh(lab.prod, `cat ${MOUNT_POINT}/test.bkp`)).toContain('No such file or directory');
  });

  it('NON-REGRESSION — un montage LOCAL reste local', () => {
    serveExport();
    mountOnClient();
    lab.sh(lab.prod, 'mkdir -p /srv/local /mnt/local');
    lab.sh(lab.prod, `sh -c 'echo LOCAL > /srv/local/fichier.txt'`);
    lab.sh(lab.prod, 'mount --bind /srv/local /mnt/local');
    expect(lab.sh(lab.prod, 'cat /srv/local/fichier.txt')).toContain('LOCAL');
    expect(lab.sh(lab.dr, 'ls /srv/local')).not.toContain('fichier.txt');
  });
});

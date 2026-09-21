/**
 * Sonde — BLOCKRECOVER repare, et le registre se vide de ce qui est
 * repare.
 *
 * BlockRecoverCommand portait en en-tete : « The simulator doesn't
 * track block-level corruption, so these are accepted as no-ops ». Le
 * lot precedent a rendu V$DATABASE_BLOCK_CORRUPTION reel ; la limite
 * nommee ne tenait donc plus, et le banc de releve
 * `debug/rman/blockrecover-registre` a mesure ce qu'elle laissait :
 *
 *   - `BLOCKRECOVER CORRUPTION LIST` sur un datafile ecrase imprimait
 *     « media recovery complete » et ne reparait RIEN : le fichier
 *     portait encore « plus un datafile », la ligne du registre restait,
 *     et le VALIDATE suivant le retrouvait FAILED ;
 *   - la portee etait passee au moteur dans le champ `untilTime`, si
 *     bien que la sortie affichait « recovering until time BLOCK
 *     RECOVER all corrupt blocks from V$DATABASE_BLOCK_CORRUPTION » ;
 *   - l'orthographe moderne `RECOVER CORRUPTION LIST` etait refusee
 *     comme commande inconnue, et `RECOVER DATAFILE 4 BLOCK 1234` etait
 *     ACCEPTEE en avalant silencieusement le `BLOCK 1234` — un critere
 *     lu par le parseur et jamais evalue (regle 6).
 *
 * AUTORITE (extraits de recherche ; docs.oracle.com est injoignable
 * depuis cet environnement, sources dans le message de commit) :
 *   - « You can identify blocks that require recovery by querying
 *     V$DATABASE_BLOCK_CORRUPTION, and then instruct RMAN to recover
 *     all blocks listed in this view by means of the CORRUPTION LIST
 *     keyword » ;
 *   - « After a corrupt block is repaired, the row identifying this
 *     block is deleted from the view » ;
 *   - « The target database must be mounted or open ».
 *
 * LA LIMITE QUI RESTE, dite : la reparation est celle d'un FICHIER, pas
 * d'un bloc. Le stockage de ce simulateur ne decoupe pas un datafile en
 * blocs adressables ; `RECOVER DATAFILE 4 BLOCK 1234` remet donc le
 * fichier 4 depuis sa sauvegarde et rejoue le redo, ce qui donne le bon
 * resultat pour le bloc demande sans savoir l'isoler.
 *
 * Discrimination par `git stash push -- src/terminal src/database` :
 * 6 cas sur 8 tombent avant le correctif.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN — sans corruption, rien n'est reecrit » : TEMOIN. Il
 *    passe avant ET apres ; c'est lui qui prouve que la reparation vient
 *    du registre mesure et non d'une restauration systematique.
 *  - « une instance arretee refuse » : NON-REGRESSION. Le refus
 *    existait deja par le chemin RECOVER ; il doit survivre au passage
 *    a une operation propre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { buildRmanLab, type RmanLab } from '../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  BackupKey._reset();
  DeviceCatalogRegistry._reset();
  lab = await buildRmanLab();
});

const USERS = '/u01/app/oracle/oradata/ORCL/users01.dbf';

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);
const rman = (srv: LinuxServer, lignes: string[]): string =>
  sh(srv, `echo "${lignes.join('\n')}" | rman target /`);

function corrompuEtConstate(): LinuxServer {
  const srv = lab.prod;
  rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
  sh(srv, `echo "plus un datafile" > ${USERS}`);
  rman(srv, ['VALIDATE DATABASE;', 'EXIT;']);
  expect(lab.sql(srv, 'SELECT file# FROM v$database_block_corruption;'))
    .not.toMatch(/no rows selected/);
  return srv;
}

describe('BLOCKRECOVER repare vraiment', () => {
  it('le datafile retrouve son contenu de sauvegarde', () => {
    const srv = corrompuEtConstate();
    rman(srv, ['BLOCKRECOVER CORRUPTION LIST;', 'EXIT;']);
    const contenu = sh(srv, `head -c 60 ${USERS}`);
    expect(contenu).toContain('ORACLE DATAFILE');
    expect(contenu).not.toContain('plus un datafile');
  });

  it('la ligne du registre disparait une fois le fichier repare', () => {
    const srv = corrompuEtConstate();
    rman(srv, ['BLOCKRECOVER CORRUPTION LIST;', 'EXIT;']);
    expect(lab.sql(srv, 'SELECT file# FROM v$database_block_corruption;'))
      .toMatch(/no rows selected/);
  });

  it('le VALIDATE qui suit ne trouve plus rien', () => {
    const srv = corrompuEtConstate();
    rman(srv, ['BLOCKRECOVER CORRUPTION LIST;', 'EXIT;']);
    const out = rman(srv, ['VALIDATE DATABASE;', 'EXIT;']);
    expect(out).toMatch(/^4\s+OK\s/m);
    expect(out).not.toContain('corrupt blocks');
  });

  it('la sortie suit le gabarit d une reprise de blocs', () => {
    const srv = corrompuEtConstate();
    const out = rman(srv, ['BLOCKRECOVER CORRUPTION LIST;', 'EXIT;']);
    expect(out).toContain('channel ORA_DISK_1: restoring block(s)');
    expect(out).toContain('restoring blocks of datafile 00004');
    expect(out).toContain('channel ORA_DISK_1: block restore complete');
    expect(out).not.toContain('recovering until time');
  });

  it('RECOVER CORRUPTION LIST — l orthographe moderne est acceptee', () => {
    const srv = corrompuEtConstate();
    const out = rman(srv, ['RECOVER CORRUPTION LIST;', 'EXIT;']);
    expect(out).not.toContain('RMAN-01009');
    expect(out).toContain('restoring blocks of datafile 00004');
    expect(lab.sql(srv, 'SELECT file# FROM v$database_block_corruption;'))
      .toMatch(/no rows selected/);
  });

  it('RECOVER DATAFILE 4 BLOCK 1234 n avale plus le BLOCK', () => {
    const srv = corrompuEtConstate();
    const out = rman(srv, ['RECOVER DATAFILE 4 BLOCK 1234;', 'EXIT;']);
    expect(out).toContain('channel ORA_DISK_1: restoring block(s)');
    expect(out).toContain('restoring blocks of datafile 00004');
    expect(sh(srv, `head -c 60 ${USERS}`)).toContain('ORACLE DATAFILE');
  });

  it('TEMOIN — sans corruption, rien n est reecrit', () => {
    const srv = lab.prod;
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    sh(srv, `echo "trace de l operateur" >> ${USERS}`);
    const avant = sh(srv, `cat ${USERS}`);
    rman(srv, ['BLOCKRECOVER CORRUPTION LIST;', 'EXIT;']);
    expect(sh(srv, `cat ${USERS}`)).toBe(avant);
  });

  it('NON-REGRESSION — une instance arretee refuse', () => {
    const srv = corrompuEtConstate();
    const out = rman(srv, ['SHUTDOWN IMMEDIATE;', 'BLOCKRECOVER CORRUPTION LIST;', 'EXIT;']);
    expect(out).toContain('RMAN-06403');
    expect(out).not.toContain('block restore complete');
  });
});

/**
 * Sonde — CHECK LOGICAL est evalue, et RESTORE VALIDATE dit ce que dit
 * VALIDATE BACKUPSET.
 *
 * Deux ecarts mesures sur `debug/rman/check-logical-et-restore-validate`
 * apres les lots VALIDATE / registre de corruption / BLOCKRECOVER :
 *
 *   - `CHECK LOGICAL` n'existait pas. Or la procedure Oracle canonique
 *     de reparation est `RUN { BACKUP VALIDATE CHECK LOGICAL DATABASE;
 *     BLOCKRECOVER CORRUPTION LIST; }` : son premier membre etait
 *     refuse comme commande inconnue, donc la procedure entiere etait
 *     intypable.
 *   - `RESTORE DATABASE VALIDATE` et `VALIDATE BACKUPSET` repondent a
 *     la MEME question — « ce jeu est-il restaurable ? » — et
 *     repondaient differemment de la MEME piece : la seconde lisait la
 *     piece et refusait, la premiere imprimait « restore validate: N
 *     backup set(s) examined » sans rien lire. C'est la contradiction
 *     entre deux vues d'un meme fait que la regle 3 nomme.
 *
 * TROUVE EN CHEMIN, ferme ici : `RESTORE ... VALIDATE` etait refuse
 * base OUVERTE (« database must be mounted (not open) »). L'exigence de
 * l'etat MOUNT porte sur la forme qui REECRIT les datafiles ; PREVIEW
 * et VALIDATE n'ecrivent rien. Elles s'executent desormais base
 * ouverte, et le cas « le datafile n'est pas touche » le prouve.
 *
 * AUTORITE (extraits de recherche ; docs.oracle.com est injoignable
 * depuis cet environnement, sources dans le message de commit) :
 * « By default, the VALIDATE command checks for physical corruption
 * only, but you can specify CHECK LOGICAL to check for logical
 * corruption as well » ; « in a physical corruption, the database does
 * not recognize the block at all, while in a logical corruption, the
 * contents of the block are logically inconsistent » ; et la reference
 * de V$DATABASE_BLOCK_CORRUPTION, qui donne LOGICAL — « Block is
 * logically corrupt » — parmi les cinq valeurs de CORRUPTION_TYPE.
 *
 * CE QUE « LOGIQUEMENT INCOHERENT » VEUT DIRE ICI, et c'est une
 * decision, pas une devinette : la banniere du datafile est intacte,
 * mais sa charge utile de segments ou bien ne s'analyse pas, ou bien
 * nomme un AUTRE tablespace que celui du fichier. Les deux se lisent
 * dans l'image reellement stockee ; ce simulateur ne modelise pas de
 * chainage inter-blocs, donc il ne pretend pas detecter davantage.
 *
 * Discrimination par `git stash push -- src/terminal src/database` :
 * 6 cas sur 8 tombent avant le correctif.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN — une base saine passe CHECK LOGICAL » : TEMOIN. Il passe
 *    avant (la commande etait refusee, mais le cas ne lit que l'absence
 *    de corruption signalee) et apres ; c'est lui qui interdit de
 *    « fermer » le defaut en declarant tout logiquement corrompu.
 *  - « VALIDATE DATABASE seul reste PHYSIQUE » : TEMOIN de la
 *    separation. Le defaut logique ne doit pas remonter dans le
 *    controle par defaut, sinon CHECK LOGICAL ne voudrait plus rien
 *    dire.
 *
 * CORRECTION (lot R16) : ce fichier EPINGLAIT un defaut. Son cas
 * PREVIEW exigeait la ligne « restore preview: n backup set(s)
 * examined », un COMPTE que le vrai RMAN n'imprime jamais — il liste les
 * sauvegardes qu'il emploierait puis les SCN de reprise. Le cas verifie
 * desormais ce que la commande DOIT rendre ; ce qu'il mesure vraiment,
 * « PREVIEW n'ecrit aucun datafile », est inchange.
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

function incoherentMaisIntact(srv: LinuxServer): void {
  const banniere = sh(srv, `cat ${USERS}`).split('\n')[0];
  sh(srv, `echo '${banniere}' > ${USERS}`);
  sh(srv, `echo 'ORACLE-SEGMENT-IMAGE {"tablespace":"SYSTEM","tables":[]}' >> ${USERS}`);
}

describe('CHECK LOGICAL est evalue, pas seulement accepte', () => {
  it('les quatre orthographes sont reconnues', () => {
    const srv = lab.prod;
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    for (const cmd of [
      'VALIDATE CHECK LOGICAL DATABASE',
      'VALIDATE CHECK LOGICAL TABLESPACE USERS',
      'VALIDATE CHECK LOGICAL DATAFILE 4',
      'BACKUP VALIDATE CHECK LOGICAL DATABASE',
    ]) {
      expect(rman(srv, [`${cmd};`, 'EXIT;'])).not.toContain('RMAN-01009');
    }
  });

  it('une charge utile qui nomme un autre tablespace est LOGICAL', () => {
    const srv = lab.prod;
    incoherentMaisIntact(srv);
    const out = rman(srv, ['VALIDATE CHECK LOGICAL DATABASE;', 'EXIT;']);
    expect(out).toMatch(/^4\s+FAILED\s/m);
    expect(out).toContain('validate found one or more corrupt blocks');
    expect(lab.sql(srv, 'SELECT file#, corruption_type FROM v$database_block_corruption;'))
      .toMatch(/^\s*4\s+LOGICAL/m);
  });

  it('TEMOIN — VALIDATE DATABASE seul reste PHYSIQUE', () => {
    const srv = lab.prod;
    incoherentMaisIntact(srv);
    const out = rman(srv, ['VALIDATE DATABASE;', 'EXIT;']);
    expect(out).toMatch(/^4\s+OK\s/m);
    expect(out).not.toContain('corrupt blocks');
  });

  it('TEMOIN — une base saine passe CHECK LOGICAL', () => {
    const srv = lab.prod;
    const out = rman(srv, ['VALIDATE CHECK LOGICAL DATABASE;', 'EXIT;']);
    expect(out).not.toContain('corrupt blocks');
    expect(lab.sql(srv, 'SELECT file# FROM v$database_block_corruption;'))
      .toMatch(/no rows selected/);
  });

  it('la procedure Oracle complete se tape d un bout a l autre', () => {
    const srv = lab.prod;
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    sh(srv, `echo "plus un datafile" > ${USERS}`);
    const out = rman(srv, [
      'BACKUP VALIDATE CHECK LOGICAL DATABASE;', 'BLOCKRECOVER CORRUPTION LIST;', 'EXIT;',
    ]);
    expect(out).not.toContain('RMAN-01009');
    expect(out).toContain('restoring blocks of datafile 00004');
    expect(sh(srv, `head -c 40 ${USERS}`)).toContain('ORACLE DATAFILE');
    expect(lab.sql(srv, 'SELECT file# FROM v$database_block_corruption;'))
      .toMatch(/no rows selected/);
  });
});

describe('RESTORE VALIDATE et VALIDATE BACKUPSET repondent pareil', () => {
  it('la meme piece corrompue est refusee par les deux', () => {
    const srv = lab.prod;
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    const piece = /(\/\S+\.bkp)/.exec(rman(srv, ['LIST BACKUP;', 'EXIT;']))?.[1] ?? '';
    expect(piece).not.toBe('');
    sh(srv, `echo "ceci n est pas une piece" > ${piece}`);
    for (const cmd of ['VALIDATE BACKUPSET 1', 'RESTORE DATABASE VALIDATE']) {
      const out = rman(srv, [`${cmd};`, 'EXIT;']);
      expect(out).toContain(`ORA-19870: error reading backup piece ${piece}`);
    }
  });

  it('RESTORE ... VALIDATE s execute base OUVERTE et n ecrit rien', () => {
    const srv = lab.prod;
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    sh(srv, `echo "trace de l operateur" >> ${USERS}`);
    const avant = sh(srv, `cat ${USERS}`);
    const out = rman(srv, ['RESTORE DATABASE VALIDATE;', 'EXIT;']);
    expect(out).not.toContain('RMAN-06403');
    expect(sh(srv, `cat ${USERS}`)).toBe(avant);
  });

  it('RESTORE ... PREVIEW aussi, et il n ecrit rien non plus', () => {
    const srv = lab.prod;
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    const avant = sh(srv, `cat ${USERS}`);
    const out = rman(srv, ['RESTORE DATABASE PREVIEW;', 'EXIT;']);
    expect(out).not.toContain('RMAN-06403');
    expect(out).toContain('List of Backup Sets');
    expect(out).toMatch(/Media recovery start SCN is \d+/);
    expect(sh(srv, `cat ${USERS}`)).toBe(avant);
  });
});

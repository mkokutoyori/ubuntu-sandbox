/**
 * Sonde — BACKUP VALIDATE et VALIDATE sont deux bannieres sur une seule
 * implantation.
 *
 * C'EST UN DOUBLON QUE J'AI INTRODUIT. Le lot « CHECK LOGICAL » a route
 * `BACKUP VALIDATE CHECK LOGICAL DATABASE` vers la commande VALIDATE
 * reelle et a LAISSE `BACKUP VALIDATE DATABASE` sur l'ancien chemin :
 * la meme famille se retrouvait partagee entre deux implantations selon
 * qu'on tapait ou non CHECK LOGICAL. La regle 2 demandait de le fermer
 * dans le meme changement ; ce lot le ferme avec un tour de retard,
 * plutot que de le laisser durer.
 *
 * Ce que le banc `debug/rman/backup-validate-vs-validate` a mesure sur
 * la MEME base, un datafile ecrase :
 *
 *   VALIDATE DATABASE          4 FAILED, « validate found one or more
 *                              corrupt blocks », ligne au registre
 *   BACKUP VALIDATE DATABASE   deux lignes de banniere, « Finished
 *                              backup », rien trouve, rien enregistre
 *
 * Et `BACKUP VALIDATE TABLESPACE` / `BACKUP VALIDATE DATAFILE` etaient
 * refusees, alors que le vrai RMAN les accepte.
 *
 * AUTORITE (extraits de recherche ; docs.oracle.com est injoignable
 * depuis cet environnement, sources dans le message de commit) :
 * « RMAN reads the files to be backed up in their entirety, as it would
 * during a real backup, but does not produce any backup sets or image
 * copies », et une validation de sauvegarde alimente
 * V$DATABASE_BLOCK_CORRUPTION. Les deux commandes font donc le MEME
 * travail ; seules leurs lignes de banniere different — d'ou une
 * implantation unique et un parametre de saveur qui ne decide QUE le
 * texte des etapes.
 *
 * Discrimination par `git stash push -- src/terminal src/database` :
 * 4 cas sur 7 tombent avant le correctif. (Une premiere redaction
 * annoncait 5 ; la mesure en donne 4, et le troisieme cas non
 * discriminant est nomme ci-dessous.)
 *
 * Les TROIS qui ne discriminent pas, nommes avec leur raison :
 *  - « BACKUP VALIDATE n'ecrit aucune piece » : NON-REGRESSION. C'est
 *    la seule chose que l'ancien chemin faisait correctement, et elle
 *    doit survivre au passage a l'implantation commune — sans quoi on
 *    aurait ferme le doublon en transformant une validation en
 *    sauvegarde.
 *  - « TEMOIN — sur une base saine, les deux disent OK » : TEMOIN. Il
 *    passe avant ET apres ; c'est lui qui prouve que l'accord mesure
 *    plus bas vient du defaut commun detecte et non d'un refus
 *    systematique.
 *  - « BACKUP VALIDATE garde ses propres lignes de banniere » : TEMOIN
 *    de la SAVEUR. L'ancien chemin imprimait deja « Starting backup » ;
 *    ce cas interdit de fermer le doublon en faisant dire « Starting
 *    validate » a une commande qui, chez Oracle, se presente comme une
 *    sauvegarde.
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

const rapport = (out: string): string[] =>
  out.split('\n').filter(l => /^\d+\s+(OK|FAILED)\s/.test(l.trim())).map(l => l.trim());

describe('les deux commandes repondent du meme datafile', () => {
  it('BACKUP VALIDATE DATABASE trouve ce que VALIDATE DATABASE trouve', () => {
    const srv = lab.prod;
    sh(srv, `echo "plus un datafile" > ${USERS}`);
    const parValidate = rapport(rman(srv, ['VALIDATE DATABASE;', 'EXIT;']));
    const parBackup   = rapport(rman(srv, ['BACKUP VALIDATE DATABASE;', 'EXIT;']));
    expect(parValidate.length).toBe(4);
    expect(parBackup).toEqual(parValidate);
    expect(parBackup.some(l => /^4\s+FAILED/.test(l))).toBe(true);
  });

  it('BACKUP VALIDATE alimente le registre de corruption', () => {
    const srv = lab.prod;
    sh(srv, `echo "plus un datafile" > ${USERS}`);
    rman(srv, ['BACKUP VALIDATE DATABASE;', 'EXIT;']);
    expect(lab.sql(srv, 'SELECT file#, corruption_type FROM v$database_block_corruption;'))
      .toMatch(/^\s*4\s+CORRUPT/m);
  });

  it('BACKUP VALIDATE garde ses propres lignes de banniere', () => {
    const srv = lab.prod;
    const out = rman(srv, ['BACKUP VALIDATE DATABASE;', 'EXIT;']);
    expect(out).toMatch(/Starting backup at /);
    expect(out).toMatch(/Finished backup at /);
    expect(out).toContain('channel ORA_DISK_1: starting validation of datafile backup set');
    expect(out).not.toMatch(/Starting validate at /);
  });

  it('les portees TABLESPACE et DATAFILE sont acceptees', () => {
    const srv = lab.prod;
    const ts = rman(srv, ['BACKUP VALIDATE TABLESPACE USERS;', 'EXIT;']);
    expect(ts).not.toContain('RMAN-01009');
    expect(rapport(ts).length).toBe(1);
    const df = rman(srv, ['BACKUP VALIDATE DATAFILE 1;', 'EXIT;']);
    expect(df).not.toContain('RMAN-01009');
    expect(rapport(df)).toEqual([expect.stringMatching(/^1\s+OK/) as unknown as string]);
  });

  it('BACKUP VALIDATE CHECK LOGICAL evalue aussi le controle logique', () => {
    const srv = lab.prod;
    const banniere = sh(srv, `cat ${USERS}`).split('\n')[0];
    sh(srv, `echo '${banniere}' > ${USERS}`);
    sh(srv, `echo 'ORACLE-SEGMENT-IMAGE {"tablespace":"SYSTEM","tables":[]}' >> ${USERS}`);
    expect(rapport(rman(srv, ['BACKUP VALIDATE DATABASE;', 'EXIT;']))
      .some(l => /^4\s+OK/.test(l))).toBe(true);
    expect(rapport(rman(srv, ['BACKUP VALIDATE CHECK LOGICAL DATABASE;', 'EXIT;']))
      .some(l => /^4\s+FAILED/.test(l))).toBe(true);
    expect(lab.sql(srv, 'SELECT corruption_type FROM v$database_block_corruption;'))
      .toContain('LOGICAL');
  });

  it('NON-REGRESSION — BACKUP VALIDATE n ecrit aucune piece', () => {
    const srv = lab.prod;
    rman(srv, ['BACKUP VALIDATE DATABASE;', 'EXIT;']);
    expect(rman(srv, ['LIST BACKUP;', 'EXIT;']))
      .toContain('no backup found in the repository');
  });

  it('TEMOIN — sur une base saine, les deux disent OK', () => {
    const srv = lab.prod;
    for (const cmd of ['VALIDATE DATABASE', 'BACKUP VALIDATE DATABASE']) {
      const out = rman(srv, [`${cmd};`, 'EXIT;']);
      expect(out).not.toContain('corrupt blocks');
      expect(out).not.toContain('FAILED');
    }
  });
});

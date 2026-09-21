/**
 * Sonde — VALIDATE verifie quelque chose.
 *
 * Dernier item ouvert du §6 de `docs/ASSESSMENT-RMAN.md` : « la
 * STRUCTURE d'une piece — en-tete, jeu de blocs, somme de controle —
 * decide de ce que VALIDATE peut verifier ». Le banc de releve
 * `debug/rman/validate-structure` a mesure que VALIDATE ne verifiait
 * RIEN : la piece ecrasee par la phrase « ceci n est pas une piece »,
 * puis EFFACEE, VALIDATE BACKUPSET 1 repondait deux fois « validating
 * backupset 1 / Finished ». C'est la forme la plus pure du defaut que
 * la regle 6 nomme : la commande a toutes les apparences d'exister sauf
 * l'effet. Un operateur qui valide sa sauvegarde AVANT le sinistre
 * apprenait qu'elle etait bonne alors qu'elle etait illisible.
 *
 * Trois ecarts de plus, mesures sur le meme banc :
 *   - « Starting backup » / « Finished backup » pour un VALIDATE ;
 *   - l'evenement BACKUP_VALIDATED etait emis et JAMAIS rendu, donc
 *     aucune « List of Datafiles » ;
 *   - une piece corrompue restait restaurable : RESTORE ecrivait la
 *     banniere de remplacement et annoncait la reussite.
 *
 * AUTORITE. docs.oracle.com est injoignable depuis cet environnement ;
 * le gabarit et les messages viennent des extraits de recherche des
 * pages Oracle « Validating Database Files and Backups » et des
 * transcriptions capturees (sources dans le message de commit) :
 *
 *   List of Datafiles
 *   =================
 *   File Status Marked Corrupt Empty Blocks Blocks Examined High SCN
 *   ---- ------ -------------- ------------ --------------- --------
 *   1    OK     0              2            127             481907
 *   File Name: /disk1/oracle/dbs/tbs_01.f
 *
 *   ORA-19870: error reading backup piece <piece>
 *   ORA-19501: read error on file "<piece>"
 *
 * CE QUI N'EST PAS RENDU, ET POURQUOI. Le vrai VALIDATE ajoute un bloc
 * « Block Type / Blocks Failing / Blocks Processed » ventile en Data,
 * Index, Other. L'image d'un datafile de ce simulateur ne porte que des
 * segments de TABLES : les index n'y sont pas, donc la ventilation ne
 * se DECIDE pas. La regle 6 dit de ne pas rendre un chiffre qu'on ne
 * peut pas decider — le bloc est omis plutot qu'invente. « Empty
 * Blocks », lui, se decide : blocs declares du fichier moins blocs
 * occupes par la charge utile reellement ecrite.
 *
 * Piege paye une fois : sans `BackupKey._reset()` entre deux cas, la
 * cle du jeu de sauvegarde s'incremente d'un cas a l'autre et
 * `VALIDATE BACKUPSET 1` designe le jeu du cas PRECEDENT, absent du
 * catalogue neuf. Trois cas repondaient alors « backupset 1 not found
 * in catalog » et ne mesuraient rien.
 *
 * Discrimination par `git stash push -- src/terminal src/database` :
 * 6 cas sur 8 tombent avant le correctif.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN — une piece intacte n est jamais refusee » : TEMOIN. Il
 *    doit passer avant ET apres, donc il ne peut pas exiger la ligne
 *    « validation complete » que le lot ajoute ; il exige un VALIDATE
 *    qui aboutit et aucun refus. C'est lui qui prouve que les refus
 *    ci-dessus viennent de la corruption mesuree et non d'un VALIDATE
 *    qui refuserait tout.
 *  - « VALIDATE BACKUPSET sur une cle inconnue refuse » : NON-REGRESSION.
 *    ValidateCommand verifiait deja la cle dans le catalogue.
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

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);
const rman = (srv: LinuxServer, lignes: string[]): string =>
  sh(srv, `echo "${lignes.join('\n')}" | rman target /`);

function sauvegarde(): { srv: LinuxServer; piece: string } {
  const srv = lab.prod;
  rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
  const liste = rman(srv, ['LIST BACKUP;', 'EXIT;']);
  const piece = /(\/\S+\.bkp)/.exec(liste)?.[1] ?? '';
  expect(piece).not.toBe('');
  return { srv, piece };
}

describe('VALIDATE lit la piece au lieu de la croire', () => {
  it('une piece ecrasee par du texte quelconque : ORA-19870', () => {
    const { srv, piece } = sauvegarde();
    sh(srv, `echo "ceci n est pas une piece" > ${piece}`);
    const out = rman(srv, ['VALIDATE BACKUPSET 1;', 'EXIT;']);
    expect(out).toContain(`ORA-19870: error reading backup piece ${piece}`);
    expect(out).toContain(`ORA-19501: read error on file "${piece}"`);
    expect(out).not.toMatch(/validation complete/);
  });

  it('une piece effacee : ORA-19505 / ORA-27037', () => {
    const { srv, piece } = sauvegarde();
    sh(srv, `rm -f ${piece}`);
    const out = rman(srv, ['VALIDATE BACKUPSET 1;', 'EXIT;']);
    expect(out).toContain(`ORA-19505: failed to identify file "${piece}"`);
    expect(out).toContain('ORA-27037: unable to obtain file status');
  });

  it('une piece dont la SOMME DE CONTROLE ne colle plus : ORA-19870', () => {
    const { srv, piece } = sauvegarde();
    const corps = sh(srv, `cat ${piece}`);
    const altere = corps.replace(/SYSTEM tablespace/, 'SYSTEM tablespaces');
    expect(altere).not.toBe(corps);
    sh(srv, `echo '${altere.replace(/'/g, '')}' > ${piece}`);
    const out = rman(srv, ['VALIDATE BACKUPSET 1;', 'EXIT;']);
    expect(out).toContain('ORA-19870: error reading backup piece');
  });

  it('une piece corrompue n est plus restaurable', () => {
    const { srv, piece } = sauvegarde();
    sh(srv, `echo "ceci n est pas une piece" > ${piece}`);
    const out = rman(srv, [
      'SHUTDOWN IMMEDIATE;', 'STARTUP MOUNT;', 'RESTORE DATABASE;', 'EXIT;',
    ]);
    expect(out).toContain('RMAN-06026: some targets not found - aborting restore');
    expect(out).toMatch(/RMAN-06023: no backup or copy of datafile \d+ found to restore/);
    expect(out).not.toMatch(/Finished restore/);
  });

  it('TEMOIN — une piece intacte n est jamais refusee', () => {
    const { srv } = sauvegarde();
    const out = rman(srv, ['VALIDATE BACKUPSET 1;', 'EXIT;']);
    expect(out).toMatch(/Finished (backup|validate) at /);
    expect(out).not.toContain('ORA-19870');
    expect(out).not.toContain('ORA-19505');
    expect(out).not.toContain('not found in catalog');
  });

  it('NON-REGRESSION — VALIDATE BACKUPSET sur une cle inconnue refuse', () => {
    const srv = lab.prod;
    const out = rman(srv, ['VALIDATE BACKUPSET 99;', 'EXIT;']);
    expect(out).toMatch(/backupset 99 not found in catalog/);
    expect(out).not.toContain('RMAN-06004: RMAN-06004');
  });
});

describe('VALIDATE rend son rapport', () => {
  it('VALIDATE DATABASE imprime la « List of Datafiles » de chaque fichier', () => {
    const srv = lab.prod;
    const out = rman(srv, ['VALIDATE DATABASE;', 'EXIT;']);
    expect(out).toContain('List of Datafiles');
    expect(out).toContain('File Status Marked Corrupt Empty Blocks Blocks Examined High SCN');
    expect(out).toContain('File Name: /u01/app/oracle/oradata/ORCL/system01.dbf');
    expect(out).toContain('File Name: /u01/app/oracle/oradata/ORCL/users01.dbf');
    const lignesOk = out.split('\n').filter(l => /^\d+\s+OK\s/.test(l.trim()));
    expect(lignesOk.length).toBe(4);
  });

  it('la pile dit « validate », pas « backup »', () => {
    const srv = lab.prod;
    const out = rman(srv, ['VALIDATE DATAFILE 1;', 'EXIT;']);
    expect(out).toMatch(/Starting validate at /);
    expect(out).toMatch(/Finished validate at /);
    expect(out).not.toMatch(/Starting backup at /);
  });
});

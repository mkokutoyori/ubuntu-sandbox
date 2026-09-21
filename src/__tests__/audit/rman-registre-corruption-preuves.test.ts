/**
 * Sonde — la corruption trouvee est ENREGISTREE, et le crosscheck lit
 * l'en-tete au lieu de compter les fichiers.
 *
 * Deux ecarts mesures sur le banc `debug/rman/validate-structure` apres
 * le lot qui fait vraiment verifier VALIDATE :
 *
 *   - `V$DATABASE_BLOCK_CORRUPTION` rendait un jeu VIDE, en dur. La vue
 *     ne pouvait rien rapporter, quoi qu'il arrive. C'est la forme de la
 *     regle 6 : une vue qui existe en apparence et jamais en effet.
 *     L'operateur qui suit la procedure Oracle — VALIDATE puis
 *     interroger la vue pour savoir QUELS blocs sont touches — lisait
 *     « no rows selected » sur une base dont VALIDATE venait de dire
 *     qu'elle etait corrompue.
 *   - CROSSCHECK repondait « found to be 'AVAILABLE' » sur une piece
 *     ecrasee par du texte quelconque, et la LIGNE elle-meme etait un
 *     litteral du JobBuilder : elle annoncait un verdict qui n'avait
 *     jamais ete calcule. Le meme passage imprimait donc
 *     « found to be 'AVAILABLE' » puis « 1 piece(s) marked EXPIRED ».
 *
 * AUTORITE (extraits de recherche ; docs.oracle.com est injoignable
 * depuis cet environnement, sources dans le message de commit) :
 *   - « If a backup is on disk, then CROSSCHECK determines whether the
 *     HEADER of the file is valid » — ce n'est donc pas un simple test
 *     d'existence ;
 *   - « If the backup validation discovers previously unmarked corrupt
 *     blocks, then RMAN updates the V$DATABASE_BLOCK_CORRUPTION view
 *     with rows describing the corruptions » ;
 *   - la ligne « validate found one or more corrupt blocks », et le
 *     fait qu'un VALIDATE DATABASE qui TROUVE de la corruption la
 *     RAPPORTE au lieu d'avorter — un fichier ABSENT, lui, reste un
 *     echec (ORA-19505 / ORA-27037).
 *
 * CORRUPTION_CHANGE# vaut 0 : la documentation reserve ce champ au SCN
 * d'une corruption LOGIQUE et impose 0 pour une corruption media, qui
 * est la seule que ce simulateur sait detecter.
 *
 * Discrimination par `git stash push -- src/terminal src/database` :
 * 4 cas sur 8 tombent avant le correctif. (Une premiere redaction de
 * cet en-tete annoncait 5 ; la mesure en donne 4, et le quatrieme cas
 * non discriminant est nomme ci-dessous.)
 *
 * Les QUATRE qui ne discriminent pas, nommes avec leur raison :
 *  - « le rapport marque le fichier corrompu FAILED » : NON-REGRESSION
 *    du lot precedent, qui a pose le rapport ; ce lot change ce qui en
 *    DECOULE (l'enregistrement et l'issue), pas le rapport.
 *  - « un datafile ABSENT reste un echec » : NON-REGRESSION. Separer
 *    « corrompu » de « absent » ne doit pas rendre l'absence tolerable.
 *  - « TEMOIN — une base intacte ne remplit pas le registre » : TEMOIN.
 *    Il passe avant ET apres ; c'est lui qui prouve que la ligne du
 *    registre vient de la corruption mesuree et non d'un enregistrement
 *    systematique.
 *  - « TEMOIN — une piece intacte reste AVAILABLE » : TEMOIN, et il
 *    passait AVANT pour la mauvaise raison — la ligne etait un litteral
 *    qui disait AVAILABLE quoi qu'il arrive. Apres le lot, il verifie
 *    qu'un verdict calcule dit encore AVAILABLE quand la piece est
 *    bonne ; c'est ce qui empeche de « fermer » le defaut en marquant
 *    tout EXPIRED.
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

function pieceSauvegardee(srv: LinuxServer): string {
  rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
  const piece = /(\/\S+\.bkp)/.exec(rman(srv, ['LIST BACKUP;', 'EXIT;']))?.[1] ?? '';
  expect(piece).not.toBe('');
  return piece;
}

describe('le registre de corruption porte ce que VALIDATE a trouve', () => {
  it('V$DATABASE_BLOCK_CORRUPTION nomme le fichier corrompu', () => {
    const srv = lab.prod;
    sh(srv, `echo "plus un datafile" > ${USERS}`);
    rman(srv, ['VALIDATE DATABASE;', 'EXIT;']);
    const vue = lab.sql(srv, 'SELECT * FROM v$database_block_corruption;');
    expect(vue).not.toMatch(/no rows selected/);
    expect(vue).toMatch(/^\s*4\s+1\s+\d+\s+0\s+CORRUPT/m);
  });

  it('le registre survit a un arret, comme tout enregistrement du fichier de controle', () => {
    const srv = lab.prod;
    sh(srv, `echo "plus un datafile" > ${USERS}`);
    rman(srv, ['VALIDATE DATABASE;', 'EXIT;']);
    rman(srv, ['SHUTDOWN IMMEDIATE;', 'STARTUP MOUNT;', 'EXIT;']);
    expect(lab.sql(srv, 'SELECT * FROM v$database_block_corruption;'))
      .not.toMatch(/no rows selected/);
  });

  it('VALIDATE RAPPORTE la corruption au lieu d avorter', () => {
    const srv = lab.prod;
    sh(srv, `echo "plus un datafile" > ${USERS}`);
    const out = rman(srv, ['VALIDATE DATABASE;', 'EXIT;']);
    expect(out).toContain('validate found one or more corrupt blocks');
    expect(out).toMatch(/Finished validate at /);
    expect(out).not.toContain('RMAN-03002');
  });

  it('NON-REGRESSION — le rapport marque le fichier corrompu FAILED', () => {
    const srv = lab.prod;
    sh(srv, `echo "plus un datafile" > ${USERS}`);
    const out = rman(srv, ['VALIDATE DATABASE;', 'EXIT;']);
    expect(out).toMatch(/^4\s+FAILED\s/m);
    expect(out).toContain(`File Name: ${USERS}`);
  });

  it('NON-REGRESSION — un datafile ABSENT reste un echec', () => {
    const srv = lab.prod;
    sh(srv, `rm -f ${USERS}`);
    const out = rman(srv, ['VALIDATE DATABASE;', 'EXIT;']);
    expect(out).toContain(`ORA-19505: failed to identify file "${USERS}"`);
    expect(out).toContain('ORA-27037: unable to obtain file status');
  });

  it('TEMOIN — une base intacte ne remplit pas le registre', () => {
    const srv = lab.prod;
    const out = rman(srv, ['VALIDATE DATABASE;', 'EXIT;']);
    expect(out).not.toContain('corrupt blocks');
    expect(lab.sql(srv, 'SELECT * FROM v$database_block_corruption;'))
      .toMatch(/no rows selected/);
  });
});

describe('CROSSCHECK lit l en-tete de la piece', () => {
  it('une piece ecrasee est marquee EXPIRED, et la ligne le dit', () => {
    const srv = lab.prod;
    const piece = pieceSauvegardee(srv);
    sh(srv, `echo "ceci n est pas une piece" > ${piece}`);
    const out = rman(srv, ['CROSSCHECK BACKUP;', 'EXIT;']);
    expect(out).toContain("crosschecked backup piece: found to be 'EXPIRED'");
    expect(out).toContain('1 piece(s) marked EXPIRED');
    expect(out).not.toContain("found to be 'AVAILABLE'");
  });

  it('TEMOIN — une piece intacte reste AVAILABLE', () => {
    const srv = lab.prod;
    pieceSauvegardee(srv);
    const out = rman(srv, ['CROSSCHECK BACKUP;', 'EXIT;']);
    expect(out).toContain("crosschecked backup piece: found to be 'AVAILABLE'");
    expect(out).not.toContain('marked EXPIRED');
  });
});

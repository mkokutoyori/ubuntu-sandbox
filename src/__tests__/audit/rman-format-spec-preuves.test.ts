/**
 * La nomenclature FORMAT des noms de pieces RMAN.
 *
 * `docs/ASSESSMENT-RMAN.md` §6 la listait parmi ce qui n'avait PAS pu
 * etre source — « la nomenclature `%U`/`%d_%T_%s_%p` des noms de
 * pieces ». Elle l'est desormais : la recherche est citee dans le
 * message de commit, et la documentation Oracle elle-meme reste
 * injoignable depuis cet environnement (proxy de sortie), ce que le
 * message dit aussi.
 *
 * MESURE AVANT (`src/__tests__/debug/rman/format-spec-couverture.debug.test.ts`) :
 * 12 specificateurs substitues sur les 20 documentes. Les huit absents
 * ressortaient TELS QUELS — un operateur qui tapait `%N` obtenait `%N`
 * dans son nom de fichier, la ou une vraie base met le nom du
 * tablespace, et `%%` rendait deux caracteres au lieu d'un.
 *
 * APRES : 20 sur 20.
 *
 * DEUX REGLES QUE LA RECHERCHE A IMPOSEES, et qui ne sont pas des
 * details de rendu :
 *
 *   `%%` ne designe pas une lettre. Le balayage cherchait `%<lettre>`
 *   et le laissait passer ; il est traite AVANT, par decoupage.
 *
 *   `%f` et `%N` ne valent que pour une COPIE IMAGE. Un jeu de
 *   sauvegarde couvre plusieurs fichiers : il n'y a alors ni fichier ni
 *   tablespace a nommer, et les substituer serait choisir au hasard
 *   lequel des quatre. Le banc mesure les deux cas.
 *
 * Discrimination : 10 cas sur 23 tombent sous
 * `git stash push -- src/terminal src/database`. Les treize autres sont
 * les specificateurs qui marchaient DEJA (`%c %d %e %I %n %p %s %T %U
 * %F`), plus trois temoins : un FORMAT litteral reste litteral, un
 * repertoire absent fait echouer la creation (`ORA-19504` / `ORA-27040`),
 * et `%f`/`%N` SANS fichier unique ne sont pas substitues au hasard.
 * Aucun ne mesure une correction ; chacun garde qu'elle n'a pas deborde.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab } from '../support/rmanLab';
import { resolveFormatSpec } from '@/terminal/subshells/rman/core/formatSpec';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  resetAllOracleInstances(); Logger.reset();
});

const CTX = {
  dbName: 'ORCL', dbId: 1234567890, activationId: 234567890,
  setNumber: 7, pieceNumber: 2, copyNumber: 1,
  logSequence: 42, logThread: 3,
  at: new Date('2026-03-09T14:05:06Z'),
};

const AVEC_FICHIER = { ...CTX, fileNumber: 4, tablespace: 'USERS' };

describe('chaque specificateur documente rend ce qu Oracle nomme', () => {
  it.each([
    ['%a', '234567890'],
    ['%c', '1'],
    ['%d', 'ORCL'],
    ['%D', '09'],
    ['%e', '42'],
    ['%h', '3'],
    ['%I', '1234567890'],
    ['%M', '03'],
    ['%n', 'ORCLxxxx'],
    ['%p', '2'],
    ['%s', '7'],
    ['%T', '20260309'],
    ['%Y', '2026'],
  ])('%s rend %s', (token, attendu) => {
    expect(resolveFormatSpec(token, CTX)).toBe(attendu);
  });

  it('%U est %u_%p_%c, la valeur par defaut d une piece', () => {
    const u = resolveFormatSpec('%u', CTX);
    expect(resolveFormatSpec('%U', CTX)).toBe(`${u}_2_1`);
  });

  it('%F est c-IIIIIIIIII-YYYYMMDD-QQ', () => {
    expect(resolveFormatSpec('%F', CTX)).toMatch(/^c-1234567890-20260309-\d{2}$/);
  });

  it('%% rend UN caractere pour cent, pas deux', () => {
    expect(resolveFormatSpec('%%', CTX)).toBe('%');
    expect(resolveFormatSpec('/u01/100%%/%d.bkp', CTX)).toBe('/u01/100%/ORCL.bkp');
  });

  it('un mot qui suit %% n est pas relu comme un specificateur', () => {
    expect(resolveFormatSpec('%%d', CTX)).toBe('%d');
  });
});

describe('%f et %N ne valent que pour une copie image', () => {
  it('avec un fichier unique, ils nomment ce fichier et son tablespace', () => {
    expect(resolveFormatSpec('%N_%f', AVEC_FICHIER)).toBe('USERS_4');
  });

  it('sans fichier unique, ils ne sont pas substitues au hasard', () => {
    expect(resolveFormatSpec('%N_%f', CTX)).toBe('%N_%f');
  });
});

/**
 * TROIS PIEGES DU LABO, tous payes comptant en ecrivant ce banc, et
 * donc ecrits ici plutot que tus :
 *
 *   `lab.rman` lance `rman` SANS cible — le script repond alors
 *   « target database is not connected » et on croit mesurer RMAN.
 *
 *   `printf '…'` casse les apostrophes du FORMAT, ET reinterprete
 *   `%d`/`%s` comme SES PROPRES conversions : `%Y-%M-%D_%d_%s.bkp` est
 *   arrive a RMAN sous la forme `2026-09-21_0_.bkp`. C'est `echo` qu'il
 *   faut, qui ne touche a rien.
 *
 *   Le repertoire de destination doit appartenir a `oracle` : un
 *   `root:root` en 755 fait echouer la creation — ce qu'une vraie base
 *   fait aussi, et que le troisieme cas ci-dessous garde.
 */
async function labAvecDepot(): Promise<ReturnType<typeof buildRmanLab> extends Promise<infer L> ? L : never> {
  const lab = await buildRmanLab();
  lab.sh(lab.prod, 'mkdir -p /u01/backup && chown oracle:oinstall /u01/backup');
  return lab;
}

const rmanCible = (
  lab: { sh(d: never, c: string): string; prod: never }, script: string,
): string => lab.sh(lab.prod, `echo "${script}" | rman target /`);

describe('de bout en bout, sur le laboratoire', () => {
  it('un FORMAT qui porte les nouveaux specificateurs produit un vrai chemin', async () => {
    const lab = await labAvecDepot();
    rmanCible(lab as never,
      "BACKUP DATABASE FORMAT '/u01/backup/%Y-%M-%D_%d_%s.bkp';");
    const trouve = lab.sh(lab.prod, 'ls /u01/backup').trim();
    expect(trouve).toMatch(/^\d{4}-\d{2}-\d{2}_ORCL_\d+\.bkp$/m);
    expect(trouve).not.toContain('%');
  }, 60000);

  it('TEMOIN — un FORMAT sans specificateur reste litteral', async () => {
    const lab = await labAvecDepot();
    rmanCible(lab as never, "BACKUP DATABASE FORMAT '/u01/backup/fixe.bkp';");
    expect(lab.sh(lab.prod, 'ls /u01/backup').trim()).toContain('fixe.bkp');
  }, 60000);

  it('TEMOIN — un repertoire absent fait echouer la creation, comme une vraie base', async () => {
    const lab = await buildRmanLab();
    const sortie = rmanCible(lab as never,
      "BACKUP DATABASE FORMAT '/u01/nexistepas/fixe.bkp';");
    expect(sortie).toContain('ORA-19504');
    expect(sortie).toContain('ORA-27040');
  }, 60000);

  it('V$DATABASE.ACTIVATION# existe et repond un nombre', async () => {
    const lab = await buildRmanLab();
    expect(lab.sql(lab.prod, 'SELECT activation# FROM v$database;')).toMatch(/\d{6,}/);
  }, 60000);
});

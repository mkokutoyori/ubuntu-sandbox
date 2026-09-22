/**
 * Sonde — la standby est protegee, et la bascule deplace le role des
 * DEUX cotes, sur le fil.
 *
 * Troisieme et dernier morceau du chantier Data Guard. Le banc
 * `debug/rman/dataguard-bascule` a mesure trois defauts, dont un qui
 * pese plus que les autres :
 *
 *   - la standby annoncait DATABASE_ROLE = PRIMARY tout en appliquant
 *     du redo : deux bases se disaient primaires au meme instant. La
 *     colonne etait ecrite EN DUR dans V$DATABASE.
 *   - SWITCHOVER_STATUS n'existait pas (ORA-00904) — c'est pourtant la
 *     colonne qu'un operateur interroge AVANT de basculer.
 *   - la standby acceptait INSERT, COMMIT **et** CREATE TABLE. Elle
 *     comptait 2 lignes quand le primaire en comptait 1 : la
 *     divergence s'installait en silence. Une standby qui accepte des
 *     ecritures n'est plus une standby.
 *   - les quatre formes de bascule (`SWITCHOVER TO`, `COMMIT TO
 *     SWITCHOVER TO`, `FAILOVER TO`, `ACTIVATE STANDBY DATABASE`)
 *     repondaient toutes « Database altered. » par le repli generique
 *     du parseur, sans deplacer aucun role.
 *
 * LA REGLE 4 DECIDE DU CHEMIN : un switchover demande a l'AUTRE base
 * de prendre le role. L'ordre part donc sur une session Oracle Net
 * reelle — celle que resout la destination `SERVICE=` — et c'est la
 * standby qui repond si elle peut. Le temoin du fil le prouve : pare-feu
 * ferme, la bascule ECHOUE et AUCUN des deux roles ne bouge. Une
 * bascule qui « reussirait » a moitie laisserait deux primaires.
 *
 * CE QUI DISTINGUE LE FAILOVER, et c'est pourquoi il a son propre
 * chemin : il ne demande RIEN a l'ancien primaire, presume perdu. Aucun
 * aller-retour, et le redo non recu est perdu.
 *
 * Discrimination par `git stash push -- src/database src/adapters
 * src/terminal` : 7 cas sur 9 tombent avant.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN — le primaire accepte ses propres ecritures » : TEMOIN.
 *    Il passe avant ET apres ; c'est lui qui interdit de fermer le
 *    defaut en refusant les ecritures partout.
 *  - « TEMOIN — une lecture reste permise sur la standby » : TEMOIN de
 *    la PORTEE. Le garde ne doit refuser que ce qui MODIFIE ; une
 *    standby qui ne se laisserait plus interroger ne servirait a rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  lab = await buildRmanLab();
});

const role = (srv: LinuxServer): string =>
  /(PRIMARY|PHYSICAL STANDBY)/.exec(
    lab.sql(srv, 'SELECT database_role FROM v$database;'))?.[1] ?? '?';

const compte = (srv: LinuxServer): number => {
  const m = /^\s*(\d+)\s*$/m.exec(lab.sql(srv, 'SELECT COUNT(*) FROM clients;'));
  return m ? Number(m[1]) : -1;
};

function paire(): { prod: LinuxServer; dr: LinuxServer } {
  const { prod, dr } = lab;
  for (const s of [prod, dr]) {
    const db = getOracleDatabase(s.getId());
    (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
  }
  lab.sql(prod,
    `ALTER SYSTEM SET LOG_ARCHIVE_DEST_2 = 'SERVICE=${lab.drIp}:1521/ORCL ASYNC DB_UNIQUE_NAME=DR';`);
  lab.sql(prod, 'ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_2 = ENABLE;');
  lab.sql(dr, 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;');
  lab.sql(prod, 'CREATE TABLE clients (id NUMBER);');
  lab.sql(prod, 'INSERT INTO clients VALUES (1);');
  lab.sql(prod, 'COMMIT;');
  lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
  return { prod, dr };
}

describe('la standby annonce et tient son role', () => {
  it('les deux cotes ne se disent plus primaires en meme temps', () => {
    const { prod, dr } = paire();
    expect(role(prod)).toBe('PRIMARY');
    expect(role(dr)).toBe('PHYSICAL STANDBY');
  });

  it('SWITCHOVER_STATUS existe et dit ce que chaque cote peut faire', () => {
    const { prod, dr } = paire();
    expect(lab.sql(prod, 'SELECT switchover_status FROM v$database;')).toContain('TO STANDBY');
    expect(lab.sql(dr, 'SELECT switchover_status FROM v$database;')).toContain('TO PRIMARY');
  });

  it('la standby REFUSE les ecritures et ne diverge pas', () => {
    const { prod, dr } = paire();
    for (const stmt of [
      'INSERT INTO clients VALUES (99);', 'COMMIT;', 'CREATE TABLE t_interdite (id NUMBER);',
      'DELETE FROM clients;', 'UPDATE clients SET id = 5;',
    ]) {
      expect(lab.sql(dr, stmt)).toContain('ORA-16000');
    }
    expect(compte(dr)).toBe(1);
    expect(compte(prod)).toBe(1);
  });

  it('TEMOIN DE PORTEE — une lecture reste permise sur la standby', () => {
    const { dr } = paire();
    expect(compte(dr)).toBe(1);
    expect(lab.sql(dr, 'SELECT name FROM v$archived_log;')).not.toContain('ORA-16000');
  });

  it('TEMOIN — le primaire accepte ses propres ecritures', () => {
    const { prod } = paire();
    expect(lab.sql(prod, 'INSERT INTO clients VALUES (2);')).not.toContain('ORA-16000');
    lab.sql(prod, 'COMMIT;');
    expect(compte(prod)).toBe(2);
  });
});

describe('la bascule deplace le role des deux cotes', () => {
  it('SWITCHOVER TO échange les roles', () => {
    const { prod, dr } = paire();
    expect(lab.sql(prod, 'ALTER DATABASE SWITCHOVER TO DR;')).toContain('Database altered.');
    expect(role(prod)).toBe('PHYSICAL STANDBY');
    expect(role(dr)).toBe('PRIMARY');
  });

  it('et le nouveau primaire accepte alors les ecritures que l ancien refuse', () => {
    const { prod, dr } = paire();
    lab.sql(prod, 'ALTER DATABASE SWITCHOVER TO DR;');
    expect(lab.sql(dr, 'INSERT INTO clients VALUES (7);')).not.toContain('ORA-16000');
    expect(lab.sql(prod, 'INSERT INTO clients VALUES (8);')).toContain('ORA-16000');
  });

  it('TEMOIN DU FIL — pare-feu ferme, la bascule echoue et AUCUN role ne bouge', async () => {
    const { prod, dr } = paire();
    for (const ligne of [
      'config firewall policy', 'edit 1', 'set action deny', 'next', 'end',
    ]) await lab.firewall.executeCommand(ligne);

    expect(lab.sql(prod, 'ALTER DATABASE SWITCHOVER TO DR;')).not.toContain('Database altered.');
    expect(role(prod)).toBe('PRIMARY');
    expect(role(dr)).toBe('PHYSICAL STANDBY');
  });

  it('FAILOVER ne demande rien a l ancien primaire', () => {
    const { prod, dr } = paire();
    expect(role(dr)).toBe('PHYSICAL STANDBY');
    expect(lab.sql(dr, 'ALTER DATABASE FAILOVER TO DR;')).toContain('Database altered.');
    expect(role(dr)).toBe('PRIMARY');
    expect(lab.sql(dr, 'INSERT INTO clients VALUES (7);')).not.toContain('ORA-16000');
    expect(role(prod)).toBe('PRIMARY');
  });
});

/**
 * `SET ROLE` et les rôles actifs par session
 * (`docs/PRD-Oracle-Access-Management.md` §2.1 objectif 1, phase P1).
 *
 * Deux défauts couplés, tous deux vérifiés sur le moteur avant d'écrire
 * cette suite :
 *
 *  - `SET ROLE` n'avait aucune branche au parseur et tombait dans celle
 *    de `SET TRANSACTION` : `SET ROLE NONE;` répondait « Transaction
 *    set. » — une confirmation, pour une commande sans effet, sous le nom
 *    d'un autre objet.
 *  - Les rôles n'étaient jamais activés ni désactivés : la fermeture
 *    transitive des octrois servait directement d'autorisation, et
 *    `SESSION_ROLES` listait un rôle même après `SET ROLE NONE`.
 *
 * Le risque nommé au §7.1 du PRD est épinglé ici aussi : désactiver un
 * rôle ne doit rien changer à ce que les vues d'administration
 * rapportent — ce sont deux questions différentes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function sysdba(name: string) {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}

const run = (sh: ReturnType<typeof sysdba>, sql: string): string =>
  sh.processLine(sql).output.join('\n');

/** SYS crée une table lisible seulement via le rôle `reader`, et alice s'y connecte. */
function labWithRole(name: string) {
  const sh = sysdba(name);
  run(sh, 'CREATE TABLE emp (id NUMBER);');
  run(sh, 'INSERT INTO emp VALUES (1);');
  run(sh, 'COMMIT;');
  run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
  run(sh, 'GRANT CREATE SESSION TO alice;');
  run(sh, 'CREATE ROLE reader;');
  run(sh, 'GRANT SELECT ON SYS.emp TO reader;');
  run(sh, 'GRANT reader TO alice;');
  run(sh, 'CONNECT alice/Aa1234');
  return sh;
}

describe('SET ROLE — la commande répond enfin d’elle-même', () => {
  it('ne se fait plus passer pour SET TRANSACTION', () => {
    const sh = labWithRole('sr1');
    const out = run(sh, 'SET ROLE NONE;');
    expect(out).not.toMatch(/Transaction set/i);
    expect(out).toMatch(/Role set/i);
    sh.dispose();
  });

  it('ORA-01924 sur un rôle qui n’est pas accordé à la session', () => {
    const sh = labWithRole('sr2');
    expect(run(sh, 'SET ROLE nosuchrole;')).toMatch(/ORA-01924/);
    sh.dispose();
  });

  it('ORA-01924 sur un rôle qui existe mais n’a pas été accordé', () => {
    const sh = sysdba('sr3');
    run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE SESSION TO alice;');
    run(sh, 'CREATE ROLE other_role;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SET ROLE other_role;')).toMatch(/ORA-01924/);
    sh.dispose();
  });
});

describe('SET ROLE — l’autorisation suit réellement', () => {
  it('SET ROLE NONE retire l’accès obtenu par le rôle', () => {
    const sh = labWithRole('sr4');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    run(sh, 'SET ROLE NONE;');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/ORA-00942/);
    sh.dispose();
  });

  it('SET ROLE reader le redonne', () => {
    const sh = labWithRole('sr5');
    run(sh, 'SET ROLE NONE;');
    run(sh, 'SET ROLE reader;');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('SET ROLE ALL réactive tout', () => {
    const sh = labWithRole('sr6');
    run(sh, 'SET ROLE NONE;');
    run(sh, 'SET ROLE ALL;');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('SET ROLE ALL EXCEPT reader laisse le rôle désactivé', () => {
    const sh = labWithRole('sr7');
    run(sh, 'SET ROLE ALL EXCEPT reader;');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/ORA-00942/);
    sh.dispose();
  });

  it('un privilège système obtenu par rôle disparaît lui aussi', () => {
    const sh = sysdba('sr8');
    run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE SESSION TO alice;');
    run(sh, 'CREATE ROLE maker;');
    run(sh, 'GRANT CREATE TABLE TO maker;');
    run(sh, 'GRANT maker TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'CREATE TABLE t1 (x NUMBER);')).toMatch(/Table created/i);
    run(sh, 'SET ROLE NONE;');
    expect(run(sh, 'CREATE TABLE t2 (x NUMBER);')).toMatch(/ORA-01031/);
    sh.dispose();
  });

  it('un privilège accordé en direct survit à SET ROLE NONE', () => {
    const sh = sysdba('sr9');
    run(sh, 'CREATE TABLE emp (id NUMBER);');
    run(sh, 'INSERT INTO emp VALUES (1);');
    run(sh, 'COMMIT;');
    run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE SESSION TO alice;');
    run(sh, 'GRANT SELECT ON SYS.emp TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'SET ROLE NONE;');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('un rôle imbriqué s’active avec son parent', () => {
    const sh = sysdba('sr10');
    run(sh, 'CREATE TABLE emp (id NUMBER);');
    run(sh, 'INSERT INTO emp VALUES (1);');
    run(sh, 'COMMIT;');
    run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE SESSION TO alice;');
    run(sh, 'CREATE ROLE inner_role;');
    run(sh, 'CREATE ROLE outer_role;');
    run(sh, 'GRANT SELECT ON SYS.emp TO inner_role;');
    run(sh, 'GRANT inner_role TO outer_role;');
    run(sh, 'GRANT outer_role TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'SET ROLE NONE;');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/ORA-00942/);
    run(sh, 'SET ROLE outer_role;');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });
});

describe('SESSION_ROLES dit la vérité', () => {
  it('liste le rôle actif', () => {
    const sh = labWithRole('sr11');
    expect(run(sh, 'SELECT * FROM SESSION_ROLES;')).toMatch(/READER/);
    sh.dispose();
  });

  it('est vide après SET ROLE NONE', () => {
    const sh = labWithRole('sr12');
    run(sh, 'SET ROLE NONE;');
    expect(run(sh, 'SELECT * FROM SESSION_ROLES;')).not.toMatch(/READER/);
    sh.dispose();
  });

  it('se repeuple après SET ROLE reader', () => {
    const sh = labWithRole('sr13');
    run(sh, 'SET ROLE NONE;');
    run(sh, 'SET ROLE reader;');
    expect(run(sh, 'SELECT * FROM SESSION_ROLES;')).toMatch(/READER/);
    sh.dispose();
  });
});

describe('les deux questions restent distinctes (risque §7.1)', () => {
  it('DBA_ROLE_PRIVS rapporte l’octroi même quand le rôle est désactivé', () => {
    const sh = labWithRole('sr14');
    run(sh, 'SET ROLE NONE;');
    // La question d'administration se pose depuis un compte qui a le droit
    // de lire le dictionnaire — un utilisateur ordinaire n'y accède pas.
    run(sh, 'CONNECT / AS SYSDBA');
    expect(run(sh, "SELECT granted_role FROM dba_role_privs WHERE grantee='ALICE';"))
      .toMatch(/READER/);
    sh.dispose();
  });

  it('désactiver un rôle ne le révoque pas — il reste réactivable', () => {
    const sh = labWithRole('sr15');
    run(sh, 'SET ROLE NONE;');
    expect(run(sh, 'SET ROLE reader;')).toMatch(/Role set/i);
    sh.dispose();
  });
});

describe('SYS n’est pas concerné', () => {
  it('SET ROLE NONE ne retire rien à SYS', () => {
    const sh = sysdba('sr16');
    run(sh, 'CREATE TABLE emp (id NUMBER);');
    run(sh, 'SET ROLE NONE;');
    expect(run(sh, 'SELECT * FROM emp;')).not.toMatch(/ORA-/);
    sh.dispose();
  });
});

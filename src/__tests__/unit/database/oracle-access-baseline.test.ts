/**
 * Le socle de la gestion des accès — ce qui marche déjà, épinglé AVANT
 * d'y toucher.
 *
 * `docs/PRD-Oracle-Access-Management.md` §1.2 recense les comportements
 * réels du moteur, et son §6 exige qu'ils soient prouvés par une suite
 * dédiée écrite avant la première modification, pour que leur
 * préservation soit démontrée et non supposée.
 *
 * Chaque cas ici est un comportement observé sur le moteur, pas une
 * intention : si l'un d'eux casse pendant l'implémentation du PRD, c'est
 * une régression, pas un ajustement.
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

describe('la porte d’entrée', () => {
  it('refuse la connexion d’un compte sans CREATE SESSION (ORA-01045)', () => {
    const sh = sysdba('b1');
    run(sh, 'CREATE USER nosess IDENTIFIED BY "Aa1234";');
    expect(run(sh, 'CONNECT nosess/Aa1234')).toMatch(/ORA-01045/);
    sh.dispose();
  });

  it('laisse la session fermée après ce refus (ORA-01012)', () => {
    const sh = sysdba('b2');
    run(sh, 'CREATE USER nosess IDENTIFIED BY "Aa1234";');
    run(sh, 'CONNECT nosess/Aa1234');
    expect(run(sh, "SELECT 'x' FROM DUAL;")).toMatch(/ORA-01012/);
    sh.dispose();
  });

  it('accepte la connexion dès que CREATE SESSION est accordé', () => {
    const sh = sysdba('b3');
    run(sh, 'CREATE USER bob IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE SESSION TO bob;');
    expect(run(sh, 'CONNECT bob/Aa1234')).toMatch(/Connected/i);
    sh.dispose();
  });

  it('refuse un mot de passe erroné (ORA-01017)', () => {
    const sh = sysdba('b4');
    run(sh, 'CREATE USER bob IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE SESSION TO bob;');
    expect(run(sh, 'CONNECT bob/wrong')).toMatch(/ORA-01017/);
    sh.dispose();
  });

  it('refuse un compte verrouillé (ORA-28000)', () => {
    const sh = sysdba('b5');
    run(sh, 'CREATE USER bob IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE SESSION TO bob;');
    run(sh, 'ALTER USER bob ACCOUNT LOCK;');
    expect(run(sh, 'CONNECT bob/Aa1234')).toMatch(/ORA-28000/);
    sh.dispose();
  });
});

describe('le refus d’administration à un non-DBA', () => {
  function asBob(sh: ReturnType<typeof sysdba>): void {
    run(sh, 'CREATE USER bob IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE SESSION TO bob;');
    run(sh, 'CONNECT bob/Aa1234');
  }

  it.each([
    ['CREATE USER carl IDENTIFIED BY "Aa1234";'],
    ['DROP USER bob;'],
    ['CREATE ROLE r1;'],
  ])('%s rend ORA-01031', (stmt) => {
    const sh = sysdba(`b6-${stmt.length}`);
    asBob(sh);
    expect(run(sh, stmt)).toMatch(/ORA-01031/);
    sh.dispose();
  });

  it('un GRANT sur une table qui ne lui appartient pas rend ORA-01031', () => {
    const sh = sysdba('b7');
    run(sh, 'CREATE TABLE secret (x NUMBER);');
    run(sh, 'CREATE USER dave IDENTIFIED BY "Aa1234";');
    asBob(sh);
    expect(run(sh, 'GRANT SELECT ON SYS.secret TO dave;')).toMatch(/ORA-01031/);
    sh.dispose();
  });
});

describe('la doctrine d’erreur d’Oracle sur les objets', () => {
  it('ORA-00942 quand l’utilisateur ne détient aucun privilège sur l’objet', () => {
    const sh = sysdba('b8');
    run(sh, 'CREATE TABLE secret (x NUMBER);');
    run(sh, 'CREATE USER bob IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE SESSION TO bob;');
    run(sh, 'CONNECT bob/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.secret;')).toMatch(/ORA-00942/);
    sh.dispose();
  });

  it('ORA-01031 quand il en détient un autre — il sait déjà que l’objet existe', () => {
    const sh = sysdba('b9');
    run(sh, 'CREATE TABLE secret (x NUMBER);');
    run(sh, 'CREATE USER bob IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE SESSION TO bob;');
    run(sh, 'GRANT SELECT ON SYS.secret TO bob;');
    run(sh, 'CONNECT bob/Aa1234');
    expect(run(sh, 'DELETE FROM SYS.secret;')).toMatch(/ORA-01031/);
    sh.dispose();
  });
});

describe('les garde-fous du DCL', () => {
  it('ORA-01917 quand le bénéficiaire n’existe pas', () => {
    const sh = sysdba('b10');
    expect(run(sh, 'GRANT CREATE SESSION TO ghost;')).toMatch(/ORA-01917/);
    sh.dispose();
  });

  it('ORA-01917 arrête tout le GRANT avant la moindre mutation', () => {
    const sh = sysdba('b11');
    run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE TABLE TO alice, ghost;');
    expect(run(sh, "SELECT privilege FROM dba_sys_privs WHERE grantee='ALICE';"))
      .not.toMatch(/CREATE TABLE/);
    sh.dispose();
  });

  it('ORA-01934 sur un octroi de rôle circulaire', () => {
    const sh = sysdba('b12');
    run(sh, 'CREATE ROLE r_a;');
    run(sh, 'CREATE ROLE r_b;');
    run(sh, 'GRANT r_a TO r_b;');
    expect(run(sh, 'GRANT r_b TO r_a;')).toMatch(/ORA-01934/);
    sh.dispose();
  });
});

describe('l’héritage par rôle', () => {
  it('un privilège objet accordé à un rôle profite à qui détient le rôle', () => {
    const sh = sysdba('b13');
    run(sh, 'CREATE TABLE emp (id NUMBER);');
    run(sh, 'INSERT INTO emp VALUES (1);');
    run(sh, 'COMMIT;');
    run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE SESSION TO alice;');
    run(sh, 'CREATE ROLE reader;');
    run(sh, 'GRANT SELECT ON SYS.emp TO reader;');
    run(sh, 'GRANT reader TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });
});

describe('les vues de session', () => {
  it('SESSION_PRIVS ne montre que les privilèges de la session courante', () => {
    const sh = sysdba('b14');
    run(sh, 'CREATE USER bob IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE SESSION TO bob;');
    run(sh, 'CONNECT bob/Aa1234');
    const out = run(sh, 'SELECT * FROM SESSION_PRIVS;');
    expect(out).toMatch(/CREATE SESSION/);
    expect(out).not.toMatch(/CREATE TABLE/);
    sh.dispose();
  });
});

describe('l’audit classique est conditionnel', () => {
  it('sans option d’audit, un SELECT ne laisse pas de trace', () => {
    const sh = sysdba('b15');
    run(sh, 'CREATE TABLE emp (id NUMBER);');
    run(sh, 'SELECT * FROM emp;');
    // Le DDL est toujours tracé ; c'est bien le SELECT qui ne doit pas l'être.
    expect(run(sh, "SELECT action_name FROM dba_audit_trail WHERE obj_name='EMP' AND action_name='SELECT';"))
      .toMatch(/no rows selected/i);
    sh.dispose();
  });

  it('avec AUDIT SELECT ON la table, le SELECT est tracé', () => {
    const sh = sysdba('b16');
    run(sh, 'CREATE TABLE emp (id NUMBER);');
    run(sh, 'AUDIT SELECT ON SYS.emp;');
    run(sh, 'SELECT * FROM SYS.emp;');
    expect(run(sh, "SELECT action_name FROM dba_audit_trail WHERE obj_name='EMP' AND action_name='SELECT';"))
      .toMatch(/SELECT/);
    sh.dispose();
  });
});

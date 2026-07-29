/**
 * L'authentification par proxy devient une vraie connexion
 * (`docs/PRD-Oracle-Access-Management.md` §1.3 item 8, phase P8).
 *
 * Vérifié sur le moteur avant d'écrire cette suite : `ALTER USER alice
 * GRANT CONNECT THROUGH appsrv` alimentait `proxyUsers`, `PROXY_USERS`
 * affichait la ligne — et `CONNECT appsrv[alice]/App1234` rendait
 * ORA-01017. La syntaxe `proxy[client]` n'était pas analysée du tout :
 * le nom d'utilisateur valait littéralement `appsrv[alice]`, un compte
 * qui n'existe pas. Le magasin le disait lui-même : « the simulator does
 * not actually arbitrate connection routing ».
 *
 * Piège de rédaction évité ici : avant le correctif, le proxy *non
 * autorisé* échouait lui aussi — mais pour une raison de syntaxe, pas
 * d'autorisation. Un test qui ne vérifierait que le refus passerait donc
 * pour de mauvaises raisons. C'est le cas autorisé qui fait foi.
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

/**
 * `alice` détient les données, `appsrv` est le serveur applicatif qui se
 * connectera pour elle, `mallory` n'a rien demandé à personne.
 */
function lab(name: string) {
  const sh = sysdba(name);
  run(sh, 'CREATE TABLE emp (id NUMBER);');
  run(sh, 'INSERT INTO emp VALUES (1);');
  run(sh, 'COMMIT;');
  run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
  run(sh, 'GRANT CREATE SESSION TO alice;');
  run(sh, 'GRANT SELECT ON SYS.emp TO alice;');
  run(sh, 'CREATE USER appsrv IDENTIFIED BY "App1234";');
  run(sh, 'GRANT CREATE SESSION TO appsrv;');
  run(sh, 'CREATE USER mallory IDENTIFIED BY "Mm1234";');
  run(sh, 'GRANT CREATE SESSION TO mallory;');
  return sh;
}

describe('un proxy autorisé ouvre la session du client', () => {
  it('la connexion est acceptée', () => {
    const sh = lab('px1');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv;');
    expect(run(sh, 'CONNECT appsrv[alice]/App1234')).toMatch(/Connected/);
    sh.dispose();
  });

  it('l’utilisateur de la session est le client, pas le proxy', () => {
    const sh = lab('px2');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv;');
    run(sh, 'CONNECT appsrv[alice]/App1234');
    expect(run(sh, 'SHOW USER')).toMatch(/ALICE/);
    sh.dispose();
  });

  it('et ce sont les privilèges du client qui s’appliquent', () => {
    const sh = lab('px3');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv;');
    run(sh, 'CONNECT appsrv[alice]/App1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('SYS_CONTEXT distingue les deux identités', () => {
    const sh = lab('px4');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv;');
    run(sh, 'CONNECT appsrv[alice]/App1234');
    const out = run(sh,
      "SELECT SYS_CONTEXT('USERENV','SESSION_USER') AS s, "
      + "SYS_CONTEXT('USERENV','PROXY_USER') AS p FROM DUAL;");
    expect(out).toMatch(/ALICE/);
    expect(out).toMatch(/APPSRV/);
    sh.dispose();
  });

  it('une connexion ordinaire n’a pas de proxy', () => {
    const sh = lab('px5');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, "SELECT NVL(SYS_CONTEXT('USERENV','PROXY_USER'),'AUCUN') FROM DUAL;"))
      .toMatch(/AUCUN/);
    sh.dispose();
  });
});

describe('c’est bien le mot de passe du proxy qui est vérifié', () => {
  it('le mot de passe du proxy ouvre la session', () => {
    const sh = lab('pw1');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv;');
    expect(run(sh, 'CONNECT appsrv[alice]/App1234')).toMatch(/Connected/);
    sh.dispose();
  });

  it('celui du client ne l’ouvre pas — le proxy ne le connaît pas', () => {
    const sh = lab('pw2');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv;');
    expect(run(sh, 'CONNECT appsrv[alice]/Aa1234')).toMatch(/ORA-01017/);
    sh.dispose();
  });

  it('un mot de passe erroné rend ORA-01017', () => {
    const sh = lab('pw3');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv;');
    expect(run(sh, 'CONNECT appsrv[alice]/wrong')).toMatch(/ORA-01017/);
    sh.dispose();
  });
});

describe('sans autorisation, le proxy est refusé', () => {
  it('un proxy que le client n’a pas désigné rend ORA-28150', () => {
    const sh = lab('nz1');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv;');
    expect(run(sh, 'CONNECT mallory[alice]/Mm1234')).toMatch(/ORA-28150/);
    sh.dispose();
  });

  it('aucune autorisation du tout rend ORA-28150', () => {
    const sh = lab('nz2');
    expect(run(sh, 'CONNECT appsrv[alice]/App1234')).toMatch(/ORA-28150/);
    sh.dispose();
  });

  it('l’autorisation ne vaut que pour le client nommé', () => {
    const sh = lab('nz3');
    run(sh, 'CREATE USER carol IDENTIFIED BY "Cc1234";');
    run(sh, 'GRANT CREATE SESSION TO carol;');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv;');
    expect(run(sh, 'CONNECT appsrv[carol]/App1234')).toMatch(/ORA-28150/);
    sh.dispose();
  });

  it('REVOKE CONNECT THROUGH referme la porte', () => {
    const sh = lab('nz4');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv;');
    run(sh, 'ALTER USER alice REVOKE CONNECT THROUGH appsrv;');
    expect(run(sh, 'CONNECT appsrv[alice]/App1234')).toMatch(/ORA-28150/);
    sh.dispose();
  });

  it('un client inexistant rend ORA-28150 plutôt que d’en révéler l’absence', () => {
    const sh = lab('nz5');
    expect(run(sh, 'CONNECT appsrv[nobody]/App1234')).toMatch(/ORA-28150/);
    sh.dispose();
  });
});

describe('WITH ROLE limite ce que la session du proxy peut activer', () => {
  function roleLab(name: string) {
    const sh = lab(name);
    run(sh, 'CREATE TABLE dept (id NUMBER);');
    run(sh, 'INSERT INTO dept VALUES (2);');
    run(sh, 'COMMIT;');
    run(sh, 'CREATE ROLE reader;');
    run(sh, 'CREATE ROLE writer;');
    run(sh, 'GRANT SELECT ON SYS.emp TO reader;');
    run(sh, 'GRANT SELECT ON SYS.dept TO writer;');
    run(sh, 'GRANT reader TO alice;');
    run(sh, 'GRANT writer TO alice;');
    return sh;
  }

  it('le rôle nommé est actif', () => {
    const sh = roleLab('wr1');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv WITH ROLE reader;');
    run(sh, 'CONNECT appsrv[alice]/App1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('les autres ne le sont pas', () => {
    const sh = roleLab('wr2');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv WITH ROLE reader;');
    run(sh, 'CONNECT appsrv[alice]/App1234');
    expect(run(sh, 'SELECT * FROM SYS.dept;')).toMatch(/ORA-00942/);
    sh.dispose();
  });

  it('sans clause WITH ROLE, le client garde ses rôles par défaut', () => {
    const sh = roleLab('wr3');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv;');
    run(sh, 'CONNECT appsrv[alice]/App1234');
    expect(run(sh, 'SELECT * FROM SYS.dept;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('SESSION_ROLES reflète la restriction', () => {
    const sh = roleLab('wr4');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv WITH ROLE reader;');
    run(sh, 'CONNECT appsrv[alice]/App1234');
    const out = run(sh, 'SELECT * FROM SESSION_ROLES;');
    expect(out).toMatch(/READER/);
    expect(out).not.toMatch(/WRITER/);
    sh.dispose();
  });
});

describe('PROXY_USERS dit ce que la contrainte autorise', () => {
  it('sans clause de rôle, le proxy peut activer tous ceux du client', () => {
    const sh = lab('vu1');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv;');
    expect(run(sh, 'SELECT authorization_constraint FROM proxy_users;'))
      .toMatch(/PROXY MAY ACTIVATE ALL CLIENT ROLES/);
    sh.dispose();
  });

  it('avec WITH ROLE, la contrainte le dit et nomme le rôle', () => {
    const sh = lab('vu2');
    run(sh, 'CREATE ROLE reader;');
    run(sh, 'GRANT reader TO alice;');
    run(sh, 'ALTER USER alice GRANT CONNECT THROUGH appsrv WITH ROLE reader;');
    const out = run(sh, 'SELECT authorization_constraint, role FROM proxy_users;');
    expect(out).toMatch(/PROXY MAY ACTIVATE ROLE/);
    expect(out).toMatch(/READER/);
    sh.dispose();
  });
});

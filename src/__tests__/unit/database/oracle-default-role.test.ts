/**
 * `ALTER USER … DEFAULT ROLE …` réellement consulté à l'ouverture de
 * session (`docs/PRD-Oracle-Access-Management.md` §2.1 objectif 1,
 * phase P2).
 *
 * `OracleCatalog.setDefaultRoleSpec()` enregistrait la clause depuis le
 * début ; `getDefaultRoleSpec()` n'avait aucun appelant. La clause était
 * donc acceptée (« User altered. »), stockée, et sans le moindre effet :
 * tous les rôles restaient actifs quoi qu'on écrive.
 *
 * Un rôle protégé par mot de passe n'est pas non plus activé par défaut —
 * c'est tout l'intérêt d'en poser un.
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
 * SYS.emp est lisible par `reader`, SYS.dept par `writer` ; alice détient
 * les deux rôles mais ne s'est pas encore connectée.
 */
function lab(name: string) {
  const sh = sysdba(name);
  run(sh, 'CREATE TABLE emp (id NUMBER);');
  run(sh, 'INSERT INTO emp VALUES (1);');
  run(sh, 'CREATE TABLE dept (id NUMBER);');
  run(sh, 'INSERT INTO dept VALUES (2);');
  run(sh, 'COMMIT;');
  run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
  run(sh, 'GRANT CREATE SESSION TO alice;');
  run(sh, 'CREATE ROLE reader;');
  run(sh, 'CREATE ROLE writer;');
  run(sh, 'GRANT SELECT ON SYS.emp TO reader;');
  run(sh, 'GRANT SELECT ON SYS.dept TO writer;');
  run(sh, 'GRANT reader TO alice;');
  run(sh, 'GRANT writer TO alice;');
  return sh;
}

describe('DEFAULT ROLE gouverne ce qui est actif au login', () => {
  it('sans clause, tous les rôles accordés sont actifs — le défaut d’Oracle', () => {
    const sh = lab('dr1');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    expect(run(sh, 'SELECT * FROM SYS.dept;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('DEFAULT ROLE NONE n’en active aucun', () => {
    const sh = lab('dr2');
    run(sh, 'ALTER USER alice DEFAULT ROLE NONE;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/ORA-00942/);
    expect(run(sh, 'SELECT * FROM SYS.dept;')).toMatch(/ORA-00942/);
    sh.dispose();
  });

  it('DEFAULT ROLE reader n’active que celui-là', () => {
    const sh = lab('dr3');
    run(sh, 'ALTER USER alice DEFAULT ROLE reader;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    expect(run(sh, 'SELECT * FROM SYS.dept;')).toMatch(/ORA-00942/);
    sh.dispose();
  });

  it('DEFAULT ROLE ALL EXCEPT writer laisse writer de côté', () => {
    const sh = lab('dr4');
    run(sh, 'ALTER USER alice DEFAULT ROLE ALL EXCEPT writer;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    expect(run(sh, 'SELECT * FROM SYS.dept;')).toMatch(/ORA-00942/);
    sh.dispose();
  });

  it('SESSION_ROLES reflète la clause au lieu de tout lister', () => {
    const sh = lab('dr5');
    run(sh, 'ALTER USER alice DEFAULT ROLE reader;');
    run(sh, 'CONNECT alice/Aa1234');
    const out = run(sh, 'SELECT * FROM SESSION_ROLES;');
    expect(out).toMatch(/READER/);
    expect(out).not.toMatch(/WRITER/);
    sh.dispose();
  });

  it('un rôle écarté du défaut reste activable à la demande', () => {
    const sh = lab('dr6');
    run(sh, 'ALTER USER alice DEFAULT ROLE NONE;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/ORA-00942/);
    run(sh, 'SET ROLE reader;');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('la clause survit à une reconnexion — c’est une propriété du compte', () => {
    const sh = lab('dr7');
    run(sh, 'ALTER USER alice DEFAULT ROLE NONE;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'SET ROLE ALL;');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/ORA-00942/);
    sh.dispose();
  });
});

describe('un rôle protégé par mot de passe n’est pas actif par défaut', () => {
  function passwordRoleLab(name: string) {
    const sh = sysdba(name);
    run(sh, 'CREATE TABLE emp (id NUMBER);');
    run(sh, 'INSERT INTO emp VALUES (1);');
    run(sh, 'COMMIT;');
    run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE SESSION TO alice;');
    run(sh, 'CREATE ROLE secure_role IDENTIFIED BY "R0le!";');
    run(sh, 'GRANT SELECT ON SYS.emp TO secure_role;');
    run(sh, 'GRANT secure_role TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    return sh;
  }

  it('l’accès n’est pas donné à l’ouverture de session', () => {
    const sh = passwordRoleLab('pr1');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/ORA-00942/);
    sh.dispose();
  });

  it('SET ROLE avec le bon mot de passe l’active', () => {
    const sh = passwordRoleLab('pr2');
    expect(run(sh, 'SET ROLE secure_role IDENTIFIED BY "R0le!";')).toMatch(/Role set/i);
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('ORA-01979 sur un mot de passe erroné', () => {
    const sh = passwordRoleLab('pr3');
    expect(run(sh, 'SET ROLE secure_role IDENTIFIED BY "wrong";')).toMatch(/ORA-01979/);
    sh.dispose();
  });

  it('ORA-01979 quand le mot de passe est simplement omis', () => {
    const sh = passwordRoleLab('pr4');
    expect(run(sh, 'SET ROLE secure_role;')).toMatch(/ORA-01979/);
    sh.dispose();
  });

  it('SET ROLE ALL ne contourne pas la protection', () => {
    const sh = passwordRoleLab('pr5');
    run(sh, 'SET ROLE ALL;');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/ORA-00942/);
    sh.dispose();
  });
});

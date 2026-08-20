/**
 * Privilèges de colonne réellement appliqués
 * (`docs/PRD-Oracle-Access-Management.md` §2.1 objectif 2, phase P3).
 *
 * Le défaut vérifié sur le moteur avant d'écrire cette suite :
 * `GRANT UPDATE (salary) ON SYS.emp TO alice` était accepté, apparaissait
 * correctement dans `DBA_COL_PRIVS`, et laissait `alice` exécuter
 * `UPDATE SYS.emp SET id = 9` — « 2 rows updated. ». Elle modifiait une
 * colonne qui ne lui avait jamais été accordée.
 *
 * `PrivilegeChecker.hasObjectPrivilege()` le disait lui-même dans son
 * commentaire : « the executor is responsible for refusing access to
 * ungranted columns ». Aucun exécuteur ne le faisait.
 *
 * Sémantique Oracle respectée ici : un privilège **table** couvre toutes
 * les colonnes, un privilège **colonne** ne couvre que les siennes, et
 * les deux s'additionnent.
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

/** SYS.emp(id, salary, dept) ; alice connectée, sans aucun privilège encore. */
function lab(name: string) {
  const sh = sysdba(name);
  run(sh, 'CREATE TABLE emp (id NUMBER, salary NUMBER, dept VARCHAR2(20));');
  run(sh, "INSERT INTO emp VALUES (1, 100, 'HR');");
  run(sh, 'COMMIT;');
  run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
  run(sh, 'GRANT CREATE SESSION TO alice;');
  return sh;
}

describe('UPDATE restreint aux colonnes accordées', () => {
  it('la colonne accordée est modifiable', () => {
    const sh = lab('cp1');
    run(sh, 'GRANT UPDATE (salary) ON SYS.emp TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'UPDATE SYS.emp SET salary = 200;')).toMatch(/1 row updated/);
    sh.dispose();
  });

  it('une autre colonne rend ORA-01031 — le défaut que ce PRD corrige', () => {
    const sh = lab('cp2');
    run(sh, 'GRANT UPDATE (salary) ON SYS.emp TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'UPDATE SYS.emp SET id = 9;')).toMatch(/ORA-01031/);
    sh.dispose();
  });

  it('la ligne n’est pas modifiée quand le refus tombe', () => {
    const sh = lab('cp3');
    run(sh, 'GRANT UPDATE (salary) ON SYS.emp TO alice;');
    run(sh, 'GRANT SELECT ON SYS.emp TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'UPDATE SYS.emp SET id = 9;');
    expect(run(sh, 'SELECT id FROM SYS.emp;')).not.toMatch(/\b9\b/);
    sh.dispose();
  });

  it('un UPDATE mixte est refusé en entier, pas à moitié', () => {
    const sh = lab('cp4');
    run(sh, 'GRANT UPDATE (salary) ON SYS.emp TO alice;');
    run(sh, 'GRANT SELECT ON SYS.emp TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'UPDATE SYS.emp SET salary = 500, id = 9;')).toMatch(/ORA-01031/);
    expect(run(sh, 'SELECT salary FROM SYS.emp;')).toMatch(/100/);
    sh.dispose();
  });

  it('deux colonnes accordées séparément sont toutes deux modifiables', () => {
    const sh = lab('cp5');
    run(sh, 'GRANT UPDATE (salary) ON SYS.emp TO alice;');
    run(sh, 'GRANT UPDATE (dept) ON SYS.emp TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, "UPDATE SYS.emp SET salary = 200, dept = 'IT';")).toMatch(/1 row updated/);
    sh.dispose();
  });
});

describe('un privilège table couvre toutes les colonnes', () => {
  it('GRANT UPDATE ON la table laisse tout modifier', () => {
    const sh = lab('cp6');
    run(sh, 'GRANT UPDATE ON SYS.emp TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'UPDATE SYS.emp SET id = 9;')).toMatch(/1 row updated/);
    sh.dispose();
  });

  it('table et colonne s’additionnent au lieu de se restreindre', () => {
    const sh = lab('cp7');
    run(sh, 'GRANT UPDATE (salary) ON SYS.emp TO alice;');
    run(sh, 'GRANT UPDATE ON SYS.emp TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'UPDATE SYS.emp SET id = 9;')).toMatch(/1 row updated/);
    sh.dispose();
  });

  it('UPDATE ANY TABLE passe outre la restriction de colonne', () => {
    const sh = lab('cp8');
    run(sh, 'GRANT UPDATE (salary) ON SYS.emp TO alice;');
    run(sh, 'GRANT UPDATE ANY TABLE TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'UPDATE SYS.emp SET id = 9;')).toMatch(/1 row updated/);
    sh.dispose();
  });

  it('le propriétaire n’est jamais restreint sur ses propres colonnes', () => {
    const sh = lab('cp9');
    expect(run(sh, 'UPDATE SYS.emp SET id = 9;')).toMatch(/1 row updated/);
    sh.dispose();
  });
});

describe('SELECT restreint aux colonnes accordées', () => {
  it('la colonne accordée est lisible', () => {
    const sh = lab('cp10');
    run(sh, 'GRANT SELECT (salary) ON SYS.emp TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT salary FROM SYS.emp;')).toMatch(/100/);
    sh.dispose();
  });

  it('une autre colonne rend ORA-01031', () => {
    const sh = lab('cp11');
    run(sh, 'GRANT SELECT (salary) ON SYS.emp TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT id FROM SYS.emp;')).toMatch(/ORA-01031/);
    sh.dispose();
  });

  it('SELECT * est refusé, il n’élague pas silencieusement', () => {
    const sh = lab('cp12');
    run(sh, 'GRANT SELECT (salary) ON SYS.emp TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/ORA-01031/);
    sh.dispose();
  });

  it('une colonne du WHERE compte autant qu’une colonne projetée', () => {
    const sh = lab('cp13');
    run(sh, 'GRANT SELECT (salary) ON SYS.emp TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT salary FROM SYS.emp WHERE id = 1;')).toMatch(/ORA-01031/);
    sh.dispose();
  });
});

describe('INSERT restreint aux colonnes accordées', () => {
  it('la colonne accordée est renseignable', () => {
    const sh = lab('cp14');
    run(sh, 'GRANT INSERT (id) ON SYS.emp TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'INSERT INTO SYS.emp (id) VALUES (2);')).toMatch(/1 row created/);
    sh.dispose();
  });

  it('une autre colonne rend ORA-01031', () => {
    const sh = lab('cp15');
    run(sh, 'GRANT INSERT (id) ON SYS.emp TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'INSERT INTO SYS.emp (id, salary) VALUES (2, 50);')).toMatch(/ORA-01031/);
    sh.dispose();
  });
});

describe('DBA_COL_PRIVS reste cohérent avec le comportement', () => {
  it('la vue rapporte exactement ce qui est appliqué', () => {
    const sh = lab('cp16');
    run(sh, 'GRANT UPDATE (salary) ON SYS.emp TO alice;');
    const out = run(sh,
      "SELECT grantee, privilege, column_name FROM dba_col_privs WHERE grantee='ALICE';");
    expect(out).toMatch(/ALICE/);
    expect(out).toMatch(/UPDATE/);
    expect(out).toMatch(/SALARY/);
    sh.dispose();
  });

  it('un REVOKE de la colonne retire aussi l’accès', () => {
    const sh = lab('cp17');
    run(sh, 'GRANT UPDATE (salary) ON SYS.emp TO alice;');
    run(sh, 'REVOKE UPDATE (salary) ON SYS.emp FROM alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'UPDATE SYS.emp SET salary = 200;')).toMatch(/ORA-00942|ORA-01031/);
    sh.dispose();
  });
});

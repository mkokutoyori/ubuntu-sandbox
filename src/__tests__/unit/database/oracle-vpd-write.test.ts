/**
 * VPD en écriture, `update_check` et `sec_relevant_cols`
 * (`docs/PRD-Oracle-Access-Management.md` §2.1 objectif 3, phase P5).
 *
 * P4 a branché le prédicat sur la lecture. Vérifié sur le moteur avant
 * d'écrire cette suite, l'écriture restait entièrement libre : sur une
 * table de deux lignes protégée par un prédicat `id = 1`, `UPDATE
 * SYS.emp SET salary = 99` répondait « 2 rows updated. » et `DELETE FROM
 * SYS.emp` « 2 rows deleted. » Un utilisateur ne pouvait pas *voir* la
 * ligne de son collègue, mais pouvait l'écraser et la supprimer.
 *
 * `update_check` n'était pas même enregistré : `executeDbmsRlsCall` ne
 * lisait pas l'argument et `DBA_POLICIES.CHK_OPTION` rendait la
 * constante `'NO'`. Un `INSERT` d'une ligne que la politique interdit de
 * relire passait donc sans un mot — le trou que `update_check` existe
 * précisément pour fermer (ORA-28115).
 *
 * `sec_relevant_cols` était stocké et rendu par `DBA_SEC_RELEVANT_COLS`,
 * sans jamais décider de rien.
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

const addPolicy = (opts: string) => `BEGIN DBMS_RLS.ADD_POLICY(${opts}); END;`;

const ON_EMP = "object_schema => 'SYS', object_name => 'EMP', "
  + "policy_name => 'P1', function_schema => 'SYS'";

/** SYS.EMP porte deux lignes ; alice a tous les droits DML dessus. */
function lab(name: string) {
  const sh = sysdba(name);
  run(sh, 'CREATE TABLE emp (id NUMBER, owner VARCHAR2(20), salary NUMBER);');
  run(sh, "INSERT INTO emp VALUES (1, 'ALICE', 10);");
  run(sh, "INSERT INTO emp VALUES (2, 'BOB', 20);");
  run(sh, 'COMMIT;');
  run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
  run(sh, 'GRANT CREATE SESSION TO alice;');
  run(sh, 'GRANT SELECT, INSERT, UPDATE, DELETE ON SYS.emp TO alice;');
  run(sh,
    "CREATE OR REPLACE FUNCTION only_first (p_schema VARCHAR2, p_obj VARCHAR2) "
    + "RETURN VARCHAR2 IS BEGIN RETURN 'id = 1'; END;");
  return sh;
}

describe('UPDATE ne peut atteindre que les lignes visibles', () => {
  it('la ligne écartée par le prédicat n’est pas comptée', () => {
    const sh = lab('w1');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST'`));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'UPDATE SYS.emp SET salary = 99;')).toMatch(/1 row updated/);
    sh.dispose();
  });

  it('et n’est réellement pas modifiée', () => {
    const sh = lab('w2');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST'`));
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'UPDATE SYS.emp SET salary = 99;');
    run(sh, 'COMMIT;');
    run(sh, 'CONNECT / AS SYSDBA');
    expect(run(sh, 'SELECT salary FROM emp WHERE id = 2;')).toMatch(/\b20\b/);
    sh.dispose();
  });

  it('une politique déclarée pour SELECT seul laisse l’UPDATE libre', () => {
    const sh = lab('w3');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST', statement_types => 'SELECT'`));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'UPDATE SYS.emp SET salary = 99;')).toMatch(/2 rows updated/);
    sh.dispose();
  });
});

describe('DELETE non plus', () => {
  it('la ligne écartée survit', () => {
    const sh = lab('w4');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST'`));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'DELETE FROM SYS.emp;')).toMatch(/1 row deleted/);
    run(sh, 'COMMIT;');
    run(sh, 'CONNECT / AS SYSDBA');
    expect(run(sh, 'SELECT COUNT(*) FROM emp;')).toMatch(/^\s*1\s*$/m);
    sh.dispose();
  });

  it('une politique déclarée pour SELECT seul ne filtre pas un DELETE', () => {
    const sh = lab('w5');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST', statement_types => 'SELECT'`));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'DELETE FROM SYS.emp;')).toMatch(/2 rows deleted/);
    sh.dispose();
  });

  it('déclarée pour DELETE seul, elle ne filtre pas un UPDATE', () => {
    const sh = lab('w6');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST', statement_types => 'DELETE'`));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'UPDATE SYS.emp SET salary = 99;')).toMatch(/2 rows updated/);
    expect(run(sh, 'DELETE FROM SYS.emp;')).toMatch(/1 row deleted/);
    sh.dispose();
  });
});

describe('update_check ferme le trou de l’écriture aveugle', () => {
  it('un INSERT que la politique interdirait de relire rend ORA-28115', () => {
    const sh = lab('w7');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST', update_check => TRUE`));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, "INSERT INTO SYS.emp VALUES (5, 'ALICE', 1);")).toMatch(/ORA-28115/);
    sh.dispose();
  });

  it('un INSERT conforme au prédicat passe', () => {
    const sh = lab('w8');
    run(sh, 'DELETE FROM emp WHERE id = 1;');
    run(sh, 'COMMIT;');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST', update_check => TRUE`));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, "INSERT INTO SYS.emp VALUES (1, 'ALICE', 1);")).toMatch(/1 row created/);
    sh.dispose();
  });

  it('sans update_check, l’INSERT passe — c’est le défaut d’Oracle', () => {
    const sh = lab('w9');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST'`));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, "INSERT INTO SYS.emp VALUES (5, 'ALICE', 1);")).toMatch(/1 row created/);
    sh.dispose();
  });

  it('un UPDATE qui ferait sortir la ligne du prédicat rend ORA-28115', () => {
    const sh = lab('w10');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST', update_check => TRUE`));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'UPDATE SYS.emp SET id = 7;')).toMatch(/ORA-28115/);
    sh.dispose();
  });

  it('un UPDATE qui la laisse dedans passe', () => {
    const sh = lab('w11');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST', update_check => TRUE`));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'UPDATE SYS.emp SET salary = 99;')).toMatch(/1 row updated/);
    sh.dispose();
  });

  it('DBA_POLICIES.CHK_OPTION rapporte l’argument au lieu d’une constante', () => {
    const sh = lab('w12');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST', update_check => TRUE`));
    expect(run(sh, "SELECT chk_option FROM dba_policies WHERE policy_name='P1';"))
      .toMatch(/YES/);
    sh.dispose();
  });

  it('et rend NO quand l’argument est omis', () => {
    const sh = lab('w13');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST'`));
    expect(run(sh, "SELECT chk_option FROM dba_policies WHERE policy_name='P1';"))
      .toMatch(/NO/);
    sh.dispose();
  });
});

describe('sec_relevant_cols n’arme la politique que sur les colonnes nommées', () => {
  const WITH_COLS = `${ON_EMP}, policy_function => 'ONLY_FIRST', `
    + "statement_types => 'SELECT', sec_relevant_cols => 'SALARY'";

  it('une requête qui ne touche pas la colonne sensible n’est pas filtrée', () => {
    const sh = lab('w14');
    run(sh, addPolicy(WITH_COLS));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT id FROM SYS.emp;')).toMatch(/2 rows selected/);
    sh.dispose();
  });

  it('la même requête qui la touche l’est', () => {
    const sh = lab('w15');
    run(sh, addPolicy(WITH_COLS));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT salary FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('la toucher dans le WHERE suffit', () => {
    const sh = lab('w16');
    run(sh, addPolicy(WITH_COLS));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT id FROM SYS.emp WHERE salary > 0;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('SELECT * les touche toutes, donc l’arme', () => {
    const sh = lab('w17');
    run(sh, addPolicy(WITH_COLS));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('sans sec_relevant_cols, toute requête est filtrée', () => {
    const sh = lab('w18');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST', statement_types => 'SELECT'`));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT id FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('DBA_SEC_RELEVANT_COLS liste la colonne déclarée', () => {
    const sh = lab('w19');
    run(sh, addPolicy(WITH_COLS));
    expect(run(sh, 'SELECT sec_rel_column FROM dba_sec_relevant_cols;')).toMatch(/SALARY/);
    sh.dispose();
  });
});

describe('les exemptions valent aussi pour l’écriture', () => {
  it('SYS écrit sans être filtré', () => {
    const sh = lab('w20');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST', update_check => TRUE`));
    expect(run(sh, 'UPDATE emp SET salary = 99;')).toMatch(/2 rows updated/);
    sh.dispose();
  });

  it('EXEMPT ACCESS POLICY aussi', () => {
    const sh = lab('w21');
    run(sh, addPolicy(`${ON_EMP}, policy_function => 'ONLY_FIRST', update_check => TRUE`));
    run(sh, 'GRANT EXEMPT ACCESS POLICY TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'UPDATE SYS.emp SET salary = 99;')).toMatch(/2 rows updated/);
    sh.dispose();
  });
});

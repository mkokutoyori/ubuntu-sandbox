/**
 * VPD / Row-Level Security appliqué en lecture
 * (`docs/PRD-Oracle-Access-Management.md` §2.1 objectif 3, phase P4).
 *
 * Deux défauts vérifiés sur le moteur avant d'écrire cette suite :
 *
 *  - **La politique était enregistrée, affichée, jamais appliquée.**
 *    `DBMS_RLS.ADD_POLICY` sur `SYS.EMP` avec une fonction rendant
 *    `'id = 1'` était acceptée, `DBA_POLICIES` la montrait — et
 *    `SELECT * FROM SYS.emp` rendait toujours les deux lignes, pour
 *    `SYS` comme pour un utilisateur ordinaire. Les seuls consommateurs
 *    de `getRlsPolicies()` étaient des vues.
 *  - **Omettre `statement_types` désarmait la politique.**
 *    `executeDbmsRlsCall` passe `''` quand l'argument est absent, et
 *    `addRlsPolicy` faisait `p.statementTypes ?? 'SELECT,INSERT,…'` :
 *    `''` n'est ni `null` ni `undefined`, le défaut ne s'appliquait
 *    donc jamais et les cinq drapeaux tombaient à faux. `DBA_POLICIES`
 *    affichait `SEL = NO` sur une politique qu'Oracle arme pour tous
 *    les types d'instruction. Même cause pour `policy_type`, rendu vide
 *    au lieu de `DYNAMIC`, et pour `policy_group`.
 *
 * Exemptions Oracle respectées ici : `SYS` n'est jamais soumis, ni le
 * détenteur d'`EXEMPT ACCESS POLICY`. Le propriétaire de l'objet, lui,
 * l'est — c'est le piège classique de VPD.
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

const addPolicy = (opts: string) =>
  `BEGIN DBMS_RLS.ADD_POLICY(${opts}); END;`;

/** SYS.EMP porte deux lignes ; alice peut la lire, sans être exemptée. */
function lab(name: string) {
  const sh = sysdba(name);
  run(sh, 'CREATE TABLE emp (id NUMBER, owner VARCHAR2(20));');
  run(sh, "INSERT INTO emp VALUES (1, 'ALICE');");
  run(sh, "INSERT INTO emp VALUES (2, 'BOB');");
  run(sh, 'COMMIT;');
  run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
  run(sh, 'GRANT CREATE SESSION TO alice;');
  run(sh, 'GRANT SELECT ON SYS.emp TO alice;');
  run(sh,
    "CREATE OR REPLACE FUNCTION only_first (p_schema VARCHAR2, p_obj VARCHAR2) "
    + "RETURN VARCHAR2 IS BEGIN RETURN 'id = 1'; END;");
  return sh;
}

describe('le prédicat de politique filtre réellement la lecture', () => {
  it('une politique active retire les lignes que le prédicat écarte', () => {
    const sh = lab('v1');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'ONLY_FIRST'"));
    run(sh, 'CONNECT alice/Aa1234');
    const out = run(sh, 'SELECT * FROM SYS.emp;');
    expect(out).toMatch(/1 row selected/);
    expect(out).not.toMatch(/BOB/);
    sh.dispose();
  });

  it('sans politique, les deux lignes sont rendues', () => {
    const sh = lab('v2');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/2 rows selected/);
    sh.dispose();
  });

  it('DISABLE_POLICY rend les lignes écartées', () => {
    const sh = lab('v3');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'ONLY_FIRST'"));
    run(sh, "BEGIN DBMS_RLS.DISABLE_POLICY('SYS','EMP','P1'); END;");
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/2 rows selected/);
    sh.dispose();
  });

  it('DROP_POLICY aussi', () => {
    const sh = lab('v4');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'ONLY_FIRST'"));
    run(sh, "BEGIN DBMS_RLS.DROP_POLICY('SYS','EMP','P1'); END;");
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/2 rows selected/);
    sh.dispose();
  });

  it('une politique sur une autre table ne filtre pas celle-ci', () => {
    const sh = lab('v5');
    run(sh, 'CREATE TABLE dept (id NUMBER);');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'DEPT', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'ONLY_FIRST'"));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/2 rows selected/);
    sh.dispose();
  });
});

describe('le prédicat se compose avec la requête au lieu de la remplacer', () => {
  it('un WHERE de l’utilisateur s’ajoute au prédicat, il ne l’annule pas', () => {
    const sh = lab('v6');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'ONLY_FIRST'"));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp WHERE id = 2;')).toMatch(/no rows selected/i);
    sh.dispose();
  });

  it('un agrégat compte les lignes visibles, pas toutes', () => {
    const sh = lab('v7');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'ONLY_FIRST'"));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT COUNT(*) FROM SYS.emp;')).toMatch(/^\s*1\s*$/m);
    sh.dispose();
  });

  it('une sous-requête est filtrée elle aussi', () => {
    const sh = lab('v8');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'ONLY_FIRST'"));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT COUNT(*) FROM (SELECT id FROM SYS.emp) t;')).toMatch(/^\s*1\s*$/m);
    sh.dispose();
  });

  it('deux politiques sur le même objet se cumulent', () => {
    const sh = lab('v9');
    run(sh,
      "CREATE OR REPLACE FUNCTION only_bob (p_schema VARCHAR2, p_obj VARCHAR2) "
      + "RETURN VARCHAR2 IS BEGIN RETURN 'owner = ''BOB'''; END;");
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'ONLY_FIRST'"));
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P2', function_schema => 'SYS', policy_function => 'ONLY_BOB'"));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/no rows selected/i);
    sh.dispose();
  });
});

describe('le prédicat voit la session qui interroge', () => {
  it('SYS_CONTEXT dans la fonction de politique donne un filtre par utilisateur', () => {
    const sh = lab('v10');
    run(sh,
      "CREATE OR REPLACE FUNCTION own_rows (p_schema VARCHAR2, p_obj VARCHAR2) "
      + "RETURN VARCHAR2 IS BEGIN RETURN 'owner = ''' "
      + "|| SYS_CONTEXT('USERENV','SESSION_USER') || ''''; END;");
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'OWN_ROWS'"));
    run(sh, 'CREATE USER bob IDENTIFIED BY "Bb1234";');
    run(sh, 'GRANT CREATE SESSION TO bob;');
    run(sh, 'GRANT SELECT ON SYS.emp TO bob;');

    run(sh, 'CONNECT alice/Aa1234');
    const asAlice = run(sh, 'SELECT * FROM SYS.emp;');
    expect(asAlice).toMatch(/ALICE/);
    expect(asAlice).not.toMatch(/BOB/);

    run(sh, 'CONNECT bob/Bb1234');
    const asBob = run(sh, 'SELECT * FROM SYS.emp;');
    expect(asBob).toMatch(/BOB/);
    expect(asBob).not.toMatch(/ALICE/);
    sh.dispose();
  });
});

describe('les exemptions d’Oracle', () => {
  it('SYS n’est jamais soumis à une politique', () => {
    const sh = lab('v11');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'ONLY_FIRST'"));
    expect(run(sh, 'SELECT * FROM emp;')).toMatch(/2 rows selected/);
    sh.dispose();
  });

  it('EXEMPT ACCESS POLICY exempte son détenteur', () => {
    const sh = lab('v12');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'ONLY_FIRST'"));
    run(sh, 'GRANT EXEMPT ACCESS POLICY TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/2 rows selected/);
    sh.dispose();
  });

  it('sans ce privilège, le même utilisateur est filtré', () => {
    const sh = lab('v13');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'ONLY_FIRST'"));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });
});

describe('statement_types décide si la lecture est concernée', () => {
  it('une politique déclarée pour INSERT seul ne filtre pas un SELECT', () => {
    const sh = lab('v14');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', "
      + "policy_function => 'ONLY_FIRST', statement_types => 'INSERT'"));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/2 rows selected/);
    sh.dispose();
  });

  it('déclarée pour SELECT, elle filtre', () => {
    const sh = lab('v15');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', "
      + "policy_function => 'ONLY_FIRST', statement_types => 'SELECT'"));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('omettre statement_types les arme tous — le défaut d’Oracle', () => {
    const sh = lab('v16');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'ONLY_FIRST'"));
    const out = run(sh, "SELECT sel, ins, upd, del FROM dba_policies WHERE policy_name='P1';");
    expect(out).not.toMatch(/\bNO\b/);
    sh.dispose();
  });

  it('omettre policy_type le laisse à DYNAMIC', () => {
    const sh = lab('v17');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'ONLY_FIRST'"));
    expect(run(sh, "SELECT policy_type FROM dba_policies WHERE policy_name='P1';"))
      .toMatch(/DYNAMIC/);
    sh.dispose();
  });

  it('omettre policy_group le laisse à SYS_DEFAULT', () => {
    const sh = lab('v18');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'ONLY_FIRST'"));
    expect(run(sh, "SELECT policy_group FROM dba_policies WHERE policy_name='P1';"))
      .toMatch(/SYS_DEFAULT/);
    sh.dispose();
  });
});

describe('un prédicat qui ne tient pas la route', () => {
  it('un prédicat vide ne restreint rien', () => {
    const sh = lab('v19');
    run(sh,
      "CREATE OR REPLACE FUNCTION no_pred (p_schema VARCHAR2, p_obj VARCHAR2) "
      + "RETURN VARCHAR2 IS BEGIN RETURN ''; END;");
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'NO_PRED'"));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/2 rows selected/);
    sh.dispose();
  });

  it('un prédicat inanalysable rend ORA-28113 au lieu de s’effacer', () => {
    const sh = lab('v20');
    run(sh,
      "CREATE OR REPLACE FUNCTION bad_pred (p_schema VARCHAR2, p_obj VARCHAR2) "
      + "RETURN VARCHAR2 IS BEGIN RETURN 'id ==== '; END;");
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'BAD_PRED'"));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/ORA-28113/);
    sh.dispose();
  });

  it('une fonction de politique absente rend ORA-28113', () => {
    const sh = lab('v21');
    run(sh, addPolicy("object_schema => 'SYS', object_name => 'EMP', "
      + "policy_name => 'P1', function_schema => 'SYS', policy_function => 'NO_SUCH_FN'"));
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/ORA-28113/);
    sh.dispose();
  });
});

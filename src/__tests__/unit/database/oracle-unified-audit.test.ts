/**
 * L'audit unifié écrit enfin dans sa trace
 * (`docs/PRD-Oracle-Access-Management.md` §1.3 item 7, phase P7).
 *
 * Vérifié sur le moteur avant d'écrire cette suite : `CREATE AUDIT
 * POLICY hr_pol ACTIONS UPDATE, DELETE ON SYS.emp` puis `AUDIT POLICY
 * hr_pol BY alice` étaient acceptés et stockés, `AUDIT_UNIFIED_POLICIES`
 * les affichait — et l'`UPDATE` d'alice ne produisait aucune ligne dans
 * `UNIFIED_AUDIT_TRAIL`, qui ne montrait que le DDL de SYS. Aucun chemin
 * d'écriture n'existait, alors que l'audit *classique* écrit réellement.
 * Deux modèles d'audit coexistaient, l'un réel, l'autre décoratif, sans
 * que rien ne le signale.
 *
 * `AUDIT_UNIFIED_ENABLED_POLICIES` n'existait pas non plus : on pouvait
 * activer une politique pour un utilisateur sans aucun moyen de le
 * relire.
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

const trail = (sh: ReturnType<typeof sysdba>, where: string): string =>
  run(sh, `SELECT dbusername, action_name, unified_audit_policies `
    + `FROM unified_audit_trail WHERE ${where};`);

/** SYS.EMP, deux comptes qui peuvent la lire et l'écrire. */
function lab(name: string) {
  const sh = sysdba(name);
  run(sh, 'CREATE TABLE emp (id NUMBER);');
  run(sh, 'INSERT INTO emp VALUES (1);');
  run(sh, 'COMMIT;');
  for (const u of ['alice', 'bob']) {
    run(sh, `CREATE USER ${u} IDENTIFIED BY "Aa1234";`);
    run(sh, `GRANT CREATE SESSION TO ${u};`);
    run(sh, `GRANT SELECT, INSERT, UPDATE, DELETE ON SYS.emp TO ${u};`);
  }
  return sh;
}

const HR_POL = "CREATE AUDIT POLICY hr_pol ACTIONS UPDATE, DELETE ON SYS.emp;";

describe('une politique activée produit une ligne de trace', () => {
  it('l’action de l’utilisateur visé est enregistrée', () => {
    const sh = lab('ua1');
    run(sh, HR_POL);
    run(sh, 'AUDIT POLICY hr_pol BY alice;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'UPDATE SYS.emp SET id = 2;');
    run(sh, 'CONNECT / AS SYSDBA');
    const out = trail(sh, "object_name='EMP' AND action_name='UPDATE'");
    expect(out).toMatch(/ALICE/);
    sh.dispose();
  });

  it('la ligne nomme la politique qui l’a déclenchée', () => {
    const sh = lab('ua2');
    run(sh, HR_POL);
    run(sh, 'AUDIT POLICY hr_pol BY alice;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'UPDATE SYS.emp SET id = 2;');
    run(sh, 'CONNECT / AS SYSDBA');
    expect(trail(sh, "action_name='UPDATE'")).toMatch(/HR_POL/);
    sh.dispose();
  });

  it('un utilisateur hors du BY n’est pas tracé', () => {
    const sh = lab('ua3');
    run(sh, HR_POL);
    run(sh, 'AUDIT POLICY hr_pol BY alice;');
    run(sh, 'CONNECT bob/Aa1234');
    run(sh, 'UPDATE SYS.emp SET id = 3;');
    run(sh, 'CONNECT / AS SYSDBA');
    expect(trail(sh, "action_name='UPDATE'")).not.toMatch(/BOB/);
    sh.dispose();
  });

  it('une action hors de la liste ne l’est pas non plus', () => {
    const sh = lab('ua4');
    run(sh, HR_POL);
    run(sh, 'AUDIT POLICY hr_pol BY alice;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'SELECT * FROM SYS.emp;');
    run(sh, 'CONNECT / AS SYSDBA');
    expect(trail(sh, "action_name='SELECT'")).toMatch(/no rows selected/i);
    sh.dispose();
  });

  it('ni la même action sur un autre objet', () => {
    const sh = lab('ua5');
    run(sh, 'CREATE TABLE dept (id NUMBER);');
    run(sh, 'INSERT INTO dept VALUES (1);');
    run(sh, 'COMMIT;');
    run(sh, 'GRANT UPDATE ON SYS.dept TO alice;');
    run(sh, HR_POL);
    run(sh, 'AUDIT POLICY hr_pol BY alice;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'UPDATE SYS.dept SET id = 9;');
    run(sh, 'CONNECT / AS SYSDBA');
    expect(trail(sh, "object_name='DEPT'")).not.toMatch(/HR_POL/);
    sh.dispose();
  });

  it('une politique créée mais jamais activée ne trace rien', () => {
    const sh = lab('ua6');
    run(sh, HR_POL);
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'UPDATE SYS.emp SET id = 2;');
    run(sh, 'CONNECT / AS SYSDBA');
    expect(trail(sh, "action_name='UPDATE'")).toMatch(/no rows selected/i);
    sh.dispose();
  });

  it('la trace porte le texte SQL réel', () => {
    const sh = lab('ua7');
    run(sh, HR_POL);
    run(sh, 'AUDIT POLICY hr_pol BY alice;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'UPDATE SYS.emp SET id = 42;');
    run(sh, 'CONNECT / AS SYSDBA');
    expect(run(sh, "SELECT sql_text FROM unified_audit_trail WHERE action_name='UPDATE';"))
      .toMatch(/42/);
    sh.dispose();
  });
});

describe('la portée de l’activation', () => {
  it('AUDIT POLICY sans BY vaut pour tout le monde', () => {
    const sh = lab('us1');
    run(sh, HR_POL);
    run(sh, 'AUDIT POLICY hr_pol;');
    run(sh, 'CONNECT bob/Aa1234');
    run(sh, 'UPDATE SYS.emp SET id = 3;');
    run(sh, 'CONNECT / AS SYSDBA');
    expect(trail(sh, "action_name='UPDATE'")).toMatch(/BOB/);
    sh.dispose();
  });

  it('EXCEPT retire l’utilisateur nommé', () => {
    const sh = lab('us2');
    run(sh, HR_POL);
    run(sh, 'AUDIT POLICY hr_pol EXCEPT bob;');
    run(sh, 'CONNECT bob/Aa1234');
    run(sh, 'UPDATE SYS.emp SET id = 3;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'UPDATE SYS.emp SET id = 4;');
    run(sh, 'CONNECT / AS SYSDBA');
    const out = trail(sh, "action_name='UPDATE'");
    expect(out).toMatch(/ALICE/);
    expect(out).not.toMatch(/BOB/);
    sh.dispose();
  });

  it('NOAUDIT arrête la trace', () => {
    const sh = lab('us3');
    run(sh, HR_POL);
    run(sh, 'AUDIT POLICY hr_pol BY alice;');
    run(sh, 'NOAUDIT POLICY hr_pol;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'UPDATE SYS.emp SET id = 2;');
    run(sh, 'CONNECT / AS SYSDBA');
    expect(trail(sh, "action_name='UPDATE'")).toMatch(/no rows selected/i);
    sh.dispose();
  });

  it('deux politiques qui portent nomment toutes les deux', () => {
    const sh = lab('us4');
    run(sh, HR_POL);
    run(sh, "CREATE AUDIT POLICY hr_pol2 ACTIONS UPDATE ON SYS.emp;");
    run(sh, 'AUDIT POLICY hr_pol BY alice;');
    run(sh, 'AUDIT POLICY hr_pol2 BY alice;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'UPDATE SYS.emp SET id = 2;');
    run(sh, 'CONNECT / AS SYSDBA');
    const out = trail(sh, "action_name='UPDATE'");
    expect(out).toMatch(/HR_POL/);
    expect(out).toMatch(/HR_POL2/);
    sh.dispose();
  });
});

describe('ACTIONS ALL et les politiques sans objet', () => {
  it('ACTIONS ALL ON une table couvre aussi la lecture', () => {
    const sh = lab('al1');
    run(sh, 'CREATE AUDIT POLICY all_pol ACTIONS ALL ON SYS.emp;');
    run(sh, 'AUDIT POLICY all_pol BY alice;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'SELECT * FROM SYS.emp;');
    run(sh, 'CONNECT / AS SYSDBA');
    expect(trail(sh, "action_name='SELECT'")).toMatch(/ALICE/);
    sh.dispose();
  });

  it('une politique sans clause ON suit l’action partout', () => {
    const sh = lab('al2');
    run(sh, 'GRANT CREATE TABLE TO alice;');
    run(sh, 'GRANT UNLIMITED TABLESPACE TO alice;');
    run(sh, 'CREATE AUDIT POLICY ddl_pol ACTIONS CREATE TABLE;');
    run(sh, 'AUDIT POLICY ddl_pol BY alice;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'CREATE TABLE t1 (x NUMBER);');
    run(sh, 'CONNECT / AS SYSDBA');
    expect(trail(sh, "action_name='CREATE TABLE' AND dbusername='ALICE'"))
      .toMatch(/DDL_POL/);
    sh.dispose();
  });
});

describe('AUDIT_UNIFIED_ENABLED_POLICIES rend l’activation lisible', () => {
  it('la politique et l’utilisateur y figurent', () => {
    const sh = lab('ep1');
    run(sh, HR_POL);
    run(sh, 'AUDIT POLICY hr_pol BY alice;');
    const out = run(sh,
      'SELECT policy_name, entity_name, entity_type, enabled_option FROM audit_unified_enabled_policies;');
    expect(out).toMatch(/HR_POL/);
    expect(out).toMatch(/ALICE/);
    sh.dispose();
  });

  it('une activation pour tous porte ALL USERS', () => {
    const sh = lab('ep2');
    run(sh, HR_POL);
    run(sh, 'AUDIT POLICY hr_pol;');
    expect(run(sh, 'SELECT entity_name FROM audit_unified_enabled_policies;'))
      .toMatch(/ALL USERS/);
    sh.dispose();
  });

  it('après NOAUDIT, la ligne disparaît', () => {
    const sh = lab('ep3');
    run(sh, HR_POL);
    run(sh, 'AUDIT POLICY hr_pol BY alice;');
    run(sh, 'NOAUDIT POLICY hr_pol;');
    expect(run(sh, 'SELECT policy_name FROM audit_unified_enabled_policies;'))
      .toMatch(/no rows selected/i);
    sh.dispose();
  });

  it('une politique jamais activée n’y figure pas', () => {
    const sh = lab('ep4');
    run(sh, HR_POL);
    expect(run(sh, 'SELECT policy_name FROM audit_unified_enabled_policies;'))
      .toMatch(/no rows selected/i);
    sh.dispose();
  });
});

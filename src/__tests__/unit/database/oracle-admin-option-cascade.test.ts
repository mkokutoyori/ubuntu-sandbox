/**
 * Déléguer un droit, et le reprendre
 * (`docs/PRD-Oracle-Access-Management.md` §1.3 items 5 et 6, phase P6).
 *
 * Quatre défauts vérifiés sur le moteur avant d'écrire cette suite, plus
 * un cinquième trouvé en le sondant :
 *
 *  - **`WITH ADMIN OPTION` ne délègue rien.** `GRANT CREATE TABLE TO
 *    alice WITH ADMIN OPTION` était accepté et `DBA_SYS_PRIVS` affichait
 *    `ADMIN_OPTION = YES` — mais `alice` accordant le même privilège à
 *    `bob` recevait ORA-01031, `SecurityDclExecutor` exigeant
 *    `GRANT ANY PRIVILEGE` pour tout octroi système. Idem pour les rôles.
 *  - **Le donneur n'était pas enregistré.** `CatalogPrivilege` n'avait
 *    pas de champ `grantor` et `DBA_TAB_PRIVS.GRANTOR` rendait la
 *    constante `'SYS'` : un octroi fait par `alice` était attribué à
 *    `SYS`. Sans cette information, aucune cascade n'est possible.
 *  - **`REVOKE` ne cascade pas.** `SYS` retirant à `alice` le privilège
 *    qu'elle tenait `WITH GRANT OPTION` laissait intact celui qu'elle
 *    avait consenti à `carol`, qui continuait de lire la table.
 *  - **N'importe qui pouvait révoquer n'importe quoi.** `executeRevoke`
 *    n'avait aucun contrôle d'autorisation : `bob`, sans le moindre
 *    droit sur `SYS.EMP`, exécutait `REVOKE SELECT ON SYS.emp FROM
 *    reader` — « Revoke succeeded. »
 *
 * L'asymétrie d'Oracle est respectée : la révocation d'un privilège
 * **objet** cascade, celle d'un privilège **système** ou d'un **rôle**
 * non.
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

/** SYS.EMP, trois comptes ordinaires et un rôle `reader`. */
function lab(name: string) {
  const sh = sysdba(name);
  run(sh, 'CREATE TABLE emp (id NUMBER);');
  run(sh, 'INSERT INTO emp VALUES (1);');
  run(sh, 'COMMIT;');
  for (const u of ['alice', 'bob', 'carol']) {
    run(sh, `CREATE USER ${u} IDENTIFIED BY "Aa1234";`);
    run(sh, `GRANT CREATE SESSION TO ${u};`);
  }
  run(sh, 'CREATE ROLE reader;');
  return sh;
}

describe('WITH ADMIN OPTION délègue un privilège système', () => {
  it('son détenteur peut le ré-accorder sans être DBA', () => {
    const sh = lab('ao1');
    run(sh, 'GRANT CREATE TABLE TO alice WITH ADMIN OPTION;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'GRANT CREATE TABLE TO bob;')).toMatch(/Grant succeeded/i);
    sh.dispose();
  });

  it('et bob s’en sert réellement', () => {
    const sh = lab('ao2');
    run(sh, 'GRANT CREATE TABLE TO alice WITH ADMIN OPTION;');
    run(sh, 'GRANT UNLIMITED TABLESPACE TO bob;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'GRANT CREATE TABLE TO bob;');
    run(sh, 'CONNECT bob/Aa1234');
    expect(run(sh, 'CREATE TABLE t1 (x NUMBER);')).toMatch(/Table created/i);
    sh.dispose();
  });

  it('sans l’option, le même octroi est refusé', () => {
    const sh = lab('ao3');
    run(sh, 'GRANT CREATE TABLE TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'GRANT CREATE TABLE TO bob;')).toMatch(/ORA-01031/);
    sh.dispose();
  });

  it('l’option ne vaut que pour le privilège qu’elle accompagne', () => {
    const sh = lab('ao4');
    run(sh, 'GRANT CREATE TABLE TO alice WITH ADMIN OPTION;');
    run(sh, 'GRANT CREATE VIEW TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'GRANT CREATE VIEW TO bob;')).toMatch(/ORA-01031/);
    sh.dispose();
  });

  it('REVOKE ADMIN OPTION FOR retire la délégation sans le privilège', () => {
    const sh = lab('ao5');
    run(sh, 'GRANT CREATE TABLE TO alice WITH ADMIN OPTION;');
    run(sh, 'REVOKE ADMIN OPTION FOR CREATE TABLE FROM alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'GRANT CREATE TABLE TO bob;')).toMatch(/ORA-01031/);
    sh.dispose();
  });
});

describe('WITH ADMIN OPTION délègue aussi un rôle', () => {
  it('son détenteur peut le ré-accorder', () => {
    const sh = lab('ar1');
    run(sh, 'GRANT SELECT ON SYS.emp TO reader;');
    run(sh, 'GRANT reader TO alice WITH ADMIN OPTION;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'GRANT reader TO bob;')).toMatch(/Grant succeeded/i);
    run(sh, 'CONNECT bob/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('sans l’option, c’est refusé', () => {
    const sh = lab('ar2');
    run(sh, 'GRANT reader TO alice;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'GRANT reader TO bob;')).toMatch(/ORA-01031/);
    sh.dispose();
  });

  it('et le détenteur peut aussi le révoquer', () => {
    const sh = lab('ar3');
    run(sh, 'GRANT reader TO alice WITH ADMIN OPTION;');
    run(sh, 'GRANT reader TO bob;');
    run(sh, 'CONNECT alice/Aa1234');
    expect(run(sh, 'REVOKE reader FROM bob;')).toMatch(/Revoke succeeded/i);
    sh.dispose();
  });
});

describe('le donneur est enregistré', () => {
  it('DBA_TAB_PRIVS.GRANTOR nomme qui a accordé, pas SYS par défaut', () => {
    const sh = lab('gr1');
    run(sh, 'GRANT SELECT ON SYS.emp TO alice WITH GRANT OPTION;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'GRANT SELECT ON SYS.emp TO carol;');
    run(sh, 'CONNECT / AS SYSDBA');
    const out = run(sh,
      "SELECT grantee, grantor FROM dba_tab_privs WHERE table_name='EMP' AND grantee='CAROL';");
    expect(out).toMatch(/ALICE/);
    sh.dispose();
  });

  it('un octroi fait par SYS reste attribué à SYS', () => {
    const sh = lab('gr2');
    run(sh, 'GRANT SELECT ON SYS.emp TO alice;');
    const out = run(sh,
      "SELECT grantor FROM dba_tab_privs WHERE table_name='EMP' AND grantee='ALICE';");
    expect(out).toMatch(/SYS/);
    sh.dispose();
  });
});

describe('la révocation d’un privilège objet cascade', () => {
  function chain(name: string) {
    const sh = lab(name);
    run(sh, 'GRANT SELECT ON SYS.emp TO alice WITH GRANT OPTION;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'GRANT SELECT ON SYS.emp TO carol;');
    run(sh, 'CONNECT / AS SYSDBA');
    return sh;
  }

  it('le bout de chaîne tombe avec le maillon retiré', () => {
    const sh = chain('rc1');
    run(sh, 'REVOKE SELECT ON SYS.emp FROM alice;');
    const out = run(sh, "SELECT grantee FROM dba_tab_privs WHERE table_name='EMP';");
    expect(out).not.toMatch(/CAROL/);
    sh.dispose();
  });

  it('et carol ne lit plus la table', () => {
    const sh = chain('rc2');
    run(sh, 'REVOKE SELECT ON SYS.emp FROM alice;');
    run(sh, 'CONNECT carol/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/ORA-00942/);
    sh.dispose();
  });

  it('la cascade descend sur trois niveaux', () => {
    const sh = lab('rc3');
    run(sh, 'GRANT SELECT ON SYS.emp TO alice WITH GRANT OPTION;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'GRANT SELECT ON SYS.emp TO bob WITH GRANT OPTION;');
    run(sh, 'CONNECT bob/Aa1234');
    run(sh, 'GRANT SELECT ON SYS.emp TO carol;');
    run(sh, 'CONNECT / AS SYSDBA');
    run(sh, 'REVOKE SELECT ON SYS.emp FROM alice;');
    const out = run(sh, "SELECT grantee FROM dba_tab_privs WHERE table_name='EMP';");
    expect(out).not.toMatch(/BOB/);
    expect(out).not.toMatch(/CAROL/);
    sh.dispose();
  });

  it('un octroi reçu d’ailleurs survit à la cascade', () => {
    const sh = chain('rc4');
    run(sh, 'GRANT SELECT ON SYS.emp TO carol;');
    run(sh, 'REVOKE SELECT ON SYS.emp FROM alice;');
    run(sh, 'CONNECT carol/Aa1234');
    expect(run(sh, 'SELECT * FROM SYS.emp;')).toMatch(/1 row selected/);
    sh.dispose();
  });

  it('la cascade ne touche pas un autre objet', () => {
    const sh = chain('rc5');
    run(sh, 'CREATE TABLE dept (id NUMBER);');
    run(sh, 'GRANT SELECT ON SYS.dept TO carol;');
    run(sh, 'REVOKE SELECT ON SYS.emp FROM alice;');
    const out = run(sh, "SELECT grantee FROM dba_tab_privs WHERE table_name='DEPT';");
    expect(out).toMatch(/CAROL/);
    sh.dispose();
  });
});

describe('un privilège système ne cascade pas — l’asymétrie d’Oracle', () => {
  it('bob garde le privilège qu’alice lui avait délégué', () => {
    const sh = lab('sc1');
    run(sh, 'GRANT CREATE TABLE TO alice WITH ADMIN OPTION;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'GRANT CREATE TABLE TO bob;');
    run(sh, 'CONNECT / AS SYSDBA');
    run(sh, 'REVOKE CREATE TABLE FROM alice;');
    expect(run(sh, "SELECT privilege FROM dba_sys_privs WHERE grantee='BOB';"))
      .toMatch(/CREATE TABLE/);
    sh.dispose();
  });

  it('un rôle non plus', () => {
    const sh = lab('sc2');
    run(sh, 'GRANT reader TO alice WITH ADMIN OPTION;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'GRANT reader TO bob;');
    run(sh, 'CONNECT / AS SYSDBA');
    run(sh, 'REVOKE reader FROM alice;');
    expect(run(sh, "SELECT granted_role FROM dba_role_privs WHERE grantee='BOB';"))
      .toMatch(/READER/);
    sh.dispose();
  });
});

describe('on ne révoque pas ce qu’on n’a pas donné', () => {
  it('un tiers sans droit sur l’objet rend ORA-01927', () => {
    const sh = lab('rv1');
    run(sh, 'GRANT SELECT ON SYS.emp TO reader;');
    run(sh, 'CONNECT bob/Aa1234');
    expect(run(sh, 'REVOKE SELECT ON SYS.emp FROM reader;')).toMatch(/ORA-01927/);
    sh.dispose();
  });

  it('le donneur, lui, reprend ce qu’il a donné', () => {
    const sh = lab('rv2');
    run(sh, 'GRANT SELECT ON SYS.emp TO alice WITH GRANT OPTION;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'GRANT SELECT ON SYS.emp TO carol;');
    expect(run(sh, 'REVOKE SELECT ON SYS.emp FROM carol;')).toMatch(/Revoke succeeded/i);
    sh.dispose();
  });

  it('SYS reprend tout, quel qu’en soit le donneur', () => {
    const sh = lab('rv3');
    run(sh, 'GRANT SELECT ON SYS.emp TO alice WITH GRANT OPTION;');
    run(sh, 'CONNECT alice/Aa1234');
    run(sh, 'GRANT SELECT ON SYS.emp TO carol;');
    run(sh, 'CONNECT / AS SYSDBA');
    expect(run(sh, 'REVOKE SELECT ON SYS.emp FROM carol;')).toMatch(/Revoke succeeded/i);
    sh.dispose();
  });

  it('révoquer un privilège système sans autorité rend ORA-01031', () => {
    const sh = lab('rv4');
    run(sh, 'GRANT CREATE TABLE TO carol;');
    run(sh, 'CONNECT bob/Aa1234');
    expect(run(sh, 'REVOKE CREATE TABLE FROM carol;')).toMatch(/ORA-01031/);
    sh.dispose();
  });

  it('avec l’option d’administration, c’est permis', () => {
    const sh = lab('rv5');
    run(sh, 'GRANT CREATE TABLE TO carol;');
    run(sh, 'GRANT CREATE TABLE TO bob WITH ADMIN OPTION;');
    run(sh, 'CONNECT bob/Aa1234');
    expect(run(sh, 'REVOKE CREATE TABLE FROM carol;')).toMatch(/Revoke succeeded/i);
    sh.dispose();
  });
});

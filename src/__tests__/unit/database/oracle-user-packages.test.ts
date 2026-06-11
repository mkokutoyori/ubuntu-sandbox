/**
 * User-defined PL/SQL packages: CREATE PACKAGE [BODY], session-scoped
 * package state, public/private member visibility, package functions
 * from SQL and PL/SQL, ORA-04067/04068 fidelity, dictionary wiring and
 * SQL*Plus multi-line source collection.
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

function server(name: string): LinuxServer {
  return new LinuxServer('linux-server', name, 100, 100);
}

function session(srv: LinuxServer): SqlPlusSubShell {
  const sh = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
  sh.processLine('SET SERVEROUTPUT ON');
  return sh;
}

/** Feed input line by line, exactly like the terminal does. */
function run(sh: SqlPlusSubShell, sql: string): string {
  const out: string[] = [];
  for (const line of sql.trim().split('\n')) out.push(...sh.processLine(line).output);
  return out.join('\n');
}

const EMP_PKG_SPEC = `CREATE OR REPLACE PACKAGE emp_pkg IS
  g_counter NUMBER := 0;
  FUNCTION get_bonus(p_sal NUMBER) RETURN NUMBER;
  PROCEDURE hire(p_name VARCHAR2);
END emp_pkg;
/`;

const EMP_PKG_BODY = `CREATE OR REPLACE PACKAGE BODY emp_pkg IS
  FUNCTION get_bonus(p_sal NUMBER) RETURN NUMBER IS
  BEGIN
    RETURN p_sal * 0.1;
  END;
  PROCEDURE hire(p_name VARCHAR2) IS
  BEGIN
    g_counter := g_counter + 1;
    DBMS_OUTPUT.PUT_LINE('Hired ' || p_name || ' #' || g_counter);
  END;
END emp_pkg;
/`;

describe('CREATE PACKAGE / PACKAGE BODY', () => {
  it('compiles multi-line spec and body collected until the slash', () => {
    const sh = session(server('p1'));
    expect(run(sh, EMP_PKG_SPEC)).toMatch(/Package created\./);
    expect(run(sh, EMP_PKG_BODY)).toMatch(/Package body created\./);
    sh.dispose();
  });

  it('a member END; inside the body does not terminate input early', () => {
    const sh = session(server('p2'));
    run(sh, EMP_PKG_SPEC);
    const out = run(sh, EMP_PKG_BODY);
    expect(out).not.toMatch(/SP2-0734/);
    expect(out).toMatch(/Package body created\./);
    sh.dispose();
  });

  it('one-line package spec still executes immediately', () => {
    const sh = session(server('p3'));
    const out = run(sh, 'CREATE OR REPLACE PACKAGE one_liner IS PROCEDURE ping; END one_liner;');
    expect(out).toMatch(/Package created\./);
    sh.dispose();
  });

  it('reports compilation errors as a warning and feeds SHOW ERRORS', () => {
    const sh = session(server('p4'));
    const out = run(sh, `CREATE OR REPLACE PACKAGE broken IS
  THIS IS NOT VALID PLSQL !!!
END broken;
/`);
    expect(out).toMatch(/Warning: Package created with compilation errors\./);
    const errors = run(sh, 'SHOW ERRORS');
    expect(errors).toMatch(/Errors for PACKAGE SYS\.BROKEN/);
    expect(errors).toMatch(/PLS-/);
    sh.dispose();
  });

  it('CREATE PACKAGE without OR REPLACE on an existing package raises ORA-00955', () => {
    const sh = session(server('p5'));
    run(sh, 'CREATE PACKAGE dup_pkg IS PROCEDURE p; END dup_pkg;');
    const out = run(sh, 'CREATE PACKAGE dup_pkg IS PROCEDURE p; END dup_pkg;');
    expect(out).toMatch(/ORA-00955/);
    sh.dispose();
  });

  it('PACKAGE BODY without a spec fails with PLS-00304', () => {
    const sh = session(server('p6'));
    const out = run(sh, `CREATE OR REPLACE PACKAGE BODY orphan IS
  PROCEDURE p IS
  BEGIN
    NULL;
  END;
END orphan;
/`);
    expect(out).toMatch(/Warning: Package Body created with compilation errors\./);
    expect(run(sh, 'SHOW ERRORS')).toMatch(/PLS-00304/);
    sh.dispose();
  });
});

describe('package execution and session state', () => {
  it('calling a subprogram of a bodiless package raises ORA-04067', () => {
    const sh = session(server('p7'));
    run(sh, EMP_PKG_SPEC);
    const out = run(sh, `EXEC emp_pkg.hire('ALICE')`);
    expect(out).toMatch(/ORA-04067: not executed, package body "SYS\.EMP_PKG" does not exist/);
    expect(out).toMatch(/ORA-06508/);
    sh.dispose();
  });

  it('package variables keep their state across calls in a session', () => {
    const sh = session(server('p8'));
    run(sh, EMP_PKG_SPEC);
    run(sh, EMP_PKG_BODY);
    expect(run(sh, `EXEC emp_pkg.hire('ALICE')`)).toMatch(/Hired ALICE #1/);
    expect(run(sh, `EXEC emp_pkg.hire('BOB')`)).toMatch(/Hired BOB #2/);
    sh.dispose();
  });

  it('package functions are callable from SQL', () => {
    const sh = session(server('p9'));
    run(sh, EMP_PKG_SPEC);
    run(sh, EMP_PKG_BODY);
    expect(run(sh, 'SELECT emp_pkg.get_bonus(1000) AS b FROM dual;')).toMatch(/100/);
    sh.dispose();
  });

  it('package functions are callable from anonymous blocks', () => {
    const sh = session(server('p10'));
    run(sh, EMP_PKG_SPEC);
    run(sh, EMP_PKG_BODY);
    const out = run(sh, `BEGIN
  DBMS_OUTPUT.PUT_LINE('bonus=' || emp_pkg.get_bonus(2000));
END;
/`);
    expect(out).toMatch(/bonus=200/);
    sh.dispose();
  });

  it('public package variables are readable and writable from outside', () => {
    const sh = session(server('p11'));
    run(sh, EMP_PKG_SPEC);
    run(sh, EMP_PKG_BODY);
    run(sh, `EXEC emp_pkg.hire('A')`);
    expect(run(sh, `BEGIN DBMS_OUTPUT.PUT_LINE('c=' || emp_pkg.g_counter); END;`)).toMatch(/c=1/);
    run(sh, `BEGIN emp_pkg.g_counter := 41; END;`);
    expect(run(sh, `EXEC emp_pkg.hire('B')`)).toMatch(/Hired B #42/);
    sh.dispose();
  });

  it('package state is independent per session', () => {
    const srv = server('p12');
    const sh1 = session(srv);
    const sh2 = session(srv);
    run(sh1, EMP_PKG_SPEC);
    run(sh1, EMP_PKG_BODY);
    expect(run(sh1, `EXEC emp_pkg.hire('A')`)).toMatch(/#1/);
    expect(run(sh1, `EXEC emp_pkg.hire('B')`)).toMatch(/#2/);
    // The other session instantiates its own state, starting at 0.
    expect(run(sh2, `EXEC emp_pkg.hire('C')`)).toMatch(/#1/);
    sh1.dispose();
    sh2.dispose();
  });

  it('recompiling the body discards session state with ORA-04068, then recovers', () => {
    const sh = session(server('p13'));
    run(sh, EMP_PKG_SPEC);
    run(sh, EMP_PKG_BODY);
    expect(run(sh, `EXEC emp_pkg.hire('A')`)).toMatch(/#1/);
    run(sh, EMP_PKG_BODY); // CREATE OR REPLACE → state invalidated
    const out = run(sh, `EXEC emp_pkg.hire('B')`);
    expect(out).toMatch(/ORA-04068: existing state of packages has been discarded/);
    expect(out).toMatch(/ORA-04061: existing state of package "SYS\.EMP_PKG"/);
    // Next call re-instantiates from scratch.
    expect(run(sh, `EXEC emp_pkg.hire('B')`)).toMatch(/#1/);
    sh.dispose();
  });

  it('the package initialization block runs once at first use', () => {
    const sh = session(server('p14'));
    run(sh, `CREATE OR REPLACE PACKAGE initpkg IS
  g_started NUMBER;
  FUNCTION started RETURN NUMBER;
END initpkg;
/`);
    run(sh, `CREATE OR REPLACE PACKAGE BODY initpkg IS
  FUNCTION started RETURN NUMBER IS
  BEGIN
    RETURN g_started;
  END;
BEGIN
  g_started := 7;
END initpkg;
/`);
    expect(run(sh, `BEGIN DBMS_OUTPUT.PUT_LINE('s=' || initpkg.started); END;`)).toMatch(/s=7/);
    sh.dispose();
  });

  it('a spec-only package of constants works without a body', () => {
    const sh = session(server('p15'));
    run(sh, `CREATE OR REPLACE PACKAGE consts IS
  c_pi CONSTANT NUMBER := 3.14;
END consts;
/`);
    expect(run(sh, `BEGIN DBMS_OUTPUT.PUT_LINE('pi=' || consts.c_pi); END;`)).toMatch(/pi=3\.14/);
    sh.dispose();
  });

  it('assigning a package constant raises PLS-00363', () => {
    const sh = session(server('p16'));
    run(sh, `CREATE OR REPLACE PACKAGE consts IS
  c_pi CONSTANT NUMBER := 3.14;
END consts;
/`);
    expect(run(sh, `BEGIN consts.c_pi := 4; END;`)).toMatch(/PLS-00363/);
    sh.dispose();
  });
});

describe('private members and visibility', () => {
  const CFG_SPEC = `CREATE OR REPLACE PACKAGE cfg IS
  c_rate CONSTANT NUMBER := 0.21;
  FUNCTION tax(p NUMBER) RETURN NUMBER;
END cfg;
/`;
  const CFG_BODY = `CREATE OR REPLACE PACKAGE BODY cfg IS
  g_calls NUMBER := 0;
  FUNCTION priv_round(x NUMBER) RETURN NUMBER IS
  BEGIN
    RETURN ROUND(x, 2);
  END;
  FUNCTION tax(p NUMBER) RETURN NUMBER IS
  BEGIN
    g_calls := g_calls + 1;
    RETURN priv_round(p * c_rate);
  END;
END cfg;
/`;

  it('public members can call private functions and read spec constants', () => {
    const sh = session(server('p17'));
    run(sh, CFG_SPEC);
    run(sh, CFG_BODY);
    expect(run(sh, 'SELECT cfg.tax(100) AS t FROM dual;')).toMatch(/21/);
    sh.dispose();
  });

  it('private members are invisible from SQL (ORA-00904)', () => {
    const sh = session(server('p18'));
    run(sh, CFG_SPEC);
    run(sh, CFG_BODY);
    expect(run(sh, 'SELECT cfg.priv_round(1.234) FROM dual;')).toMatch(/ORA-00904/);
    sh.dispose();
  });

  it('private members are invisible from PL/SQL (PLS-00302)', () => {
    const sh = session(server('p19'));
    run(sh, CFG_SPEC);
    run(sh, CFG_BODY);
    expect(run(sh, `BEGIN DBMS_OUTPUT.PUT_LINE(cfg.priv_round(1.234)); END;`)).toMatch(/PLS-00302/);
    sh.dispose();
  });

  it('private body variables are invisible from outside (PLS-00302)', () => {
    const sh = session(server('p20'));
    run(sh, CFG_SPEC);
    run(sh, CFG_BODY);
    expect(run(sh, `BEGIN DBMS_OUTPUT.PUT_LINE(cfg.g_calls); END;`)).toMatch(/PLS-00302/);
    sh.dispose();
  });
});

describe('DROP and dictionary integration', () => {
  it('DROP PACKAGE BODY keeps the spec; calls then raise ORA-04067', () => {
    const sh = session(server('p21'));
    run(sh, EMP_PKG_SPEC);
    run(sh, EMP_PKG_BODY);
    expect(run(sh, 'DROP PACKAGE BODY emp_pkg;')).toMatch(/Package body dropped\./);
    expect(run(sh, `EXEC emp_pkg.hire('EVE')`)).toMatch(/ORA-04067/);
    sh.dispose();
  });

  it('DROP PACKAGE removes everything; calls then raise PLS-00201', () => {
    const sh = session(server('p22'));
    run(sh, EMP_PKG_SPEC);
    run(sh, EMP_PKG_BODY);
    expect(run(sh, 'DROP PACKAGE emp_pkg;')).toMatch(/Package dropped\./);
    expect(run(sh, `EXEC emp_pkg.hire('EVE')`)).toMatch(/PLS-00201/);
    sh.dispose();
  });

  it('DBA_OBJECTS lists PACKAGE and PACKAGE BODY as VALID', () => {
    const sh = session(server('p23'));
    run(sh, EMP_PKG_SPEC);
    run(sh, EMP_PKG_BODY);
    const out = run(sh, "SELECT object_name, object_type, status FROM dba_objects WHERE object_name = 'EMP_PKG';");
    expect(out).toMatch(/PACKAGE\s+VALID/);
    expect(out).toMatch(/PACKAGE BODY\s+VALID/);
    sh.dispose();
  });

  it('DBA_PROCEDURES exposes members with OBJECT_NAME=package, PROCEDURE_NAME=member', () => {
    const sh = session(server('p24'));
    run(sh, EMP_PKG_SPEC);
    run(sh, EMP_PKG_BODY);
    const out = run(sh, "SELECT object_name, procedure_name FROM dba_procedures WHERE object_name = 'EMP_PKG';");
    expect(out).toMatch(/EMP_PKG\s+GET_BONUS/);
    expect(out).toMatch(/EMP_PKG\s+HIRE/);
    sh.dispose();
  });

  it('DBA_SOURCE carries the package source lines', () => {
    const sh = session(server('p25'));
    run(sh, EMP_PKG_SPEC);
    run(sh, EMP_PKG_BODY);
    const out = run(sh, "SELECT COUNT(*) AS n FROM dba_source WHERE name = 'EMP_PKG';");
    expect(out).toMatch(/16/);
    sh.dispose();
  });

  it('DESCRIBE lists the public subprograms with their arguments', () => {
    const sh = session(server('p26'));
    run(sh, EMP_PKG_SPEC);
    run(sh, EMP_PKG_BODY);
    const out = run(sh, 'DESCRIBE emp_pkg');
    expect(out).toMatch(/FUNCTION GET_BONUS RETURNS NUMBER/);
    expect(out).toMatch(/P_SAL\s+NUMBER\s+IN/);
    expect(out).toMatch(/PROCEDURE HIRE/);
    expect(out).toMatch(/P_NAME\s+VARCHAR2\s+IN/);
    sh.dispose();
  });
});

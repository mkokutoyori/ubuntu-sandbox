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
function run(sh: SqlPlusSubShell, sql: string): string {
  return sh.processLine(sql).output.join('\n');
}
function block(sh: SqlPlusSubShell, src: string): string {
  return run(sh, src.trim());
}

describe('PL/SQL anonymous blocks', () => {
  it('declares and prints variables with concatenation', () => {
    const sh = session(server('p1'));
    const out = block(sh, `
      DECLARE
        v_name VARCHAR2(20) := 'World';
        v_n NUMBER := 3;
      BEGIN
        DBMS_OUTPUT.PUT_LINE('Hello, ' || v_name || ' x' || v_n);
      END;
    `);
    expect(out).toMatch(/Hello, World x3/);
    sh.dispose();
  });

  it('evaluates arithmetic with precedence and parentheses', () => {
    const sh = session(server('p2'));
    const out = block(sh, `
      DECLARE
        r NUMBER;
      BEGIN
        r := 2 + 3 * 4 - (10 / 2);
        DBMS_OUTPUT.PUT_LINE('R=' || r);
      END;
    `);
    expect(out).toMatch(/R=9/);
    sh.dispose();
  });

  it('handles constants and NOT NULL defaults', () => {
    const sh = session(server('p3'));
    const out = block(sh, `
      DECLARE
        c CONSTANT NUMBER := 100;
      BEGIN
        DBMS_OUTPUT.PUT_LINE('C=' || c);
      END;
    `);
    expect(out).toMatch(/C=100/);
    sh.dispose();
  });
});

describe('PL/SQL control flow', () => {
  it('IF/ELSIF/ELSE', () => {
    const sh = session(server('c1'));
    const out = block(sh, `
      DECLARE g NUMBER := 85;
      BEGIN
        IF g >= 90 THEN DBMS_OUTPUT.PUT_LINE('A');
        ELSIF g >= 80 THEN DBMS_OUTPUT.PUT_LINE('B');
        ELSE DBMS_OUTPUT.PUT_LINE('C'); END IF;
      END;
    `);
    expect(out).toMatch(/B/);
    expect(out).not.toMatch(/A|C/);
    sh.dispose();
  });

  it('searched CASE statement', () => {
    const sh = session(server('c2'));
    const out = block(sh, `
      DECLARE n NUMBER := 2;
      BEGIN
        CASE
          WHEN n = 1 THEN DBMS_OUTPUT.PUT_LINE('one');
          WHEN n = 2 THEN DBMS_OUTPUT.PUT_LINE('two');
          ELSE DBMS_OUTPUT.PUT_LINE('other');
        END CASE;
      END;
    `);
    expect(out).toMatch(/two/);
    sh.dispose();
  });

  it('simple CASE statement on selector', () => {
    const sh = session(server('c3'));
    const out = block(sh, `
      DECLARE s VARCHAR2(5) := 'B';
      BEGIN
        CASE s
          WHEN 'A' THEN DBMS_OUTPUT.PUT_LINE('alpha');
          WHEN 'B' THEN DBMS_OUTPUT.PUT_LINE('bravo');
          ELSE DBMS_OUTPUT.PUT_LINE('none');
        END CASE;
      END;
    `);
    expect(out).toMatch(/bravo/);
    sh.dispose();
  });

  it('numeric FOR loop and REVERSE', () => {
    const sh = session(server('c4'));
    const out = block(sh, `
      DECLARE total NUMBER := 0;
      BEGIN
        FOR i IN 1..5 LOOP total := total + i; END LOOP;
        DBMS_OUTPUT.PUT_LINE('sum=' || total);
        FOR j IN REVERSE 1..3 LOOP DBMS_OUTPUT.PUT_LINE('j=' || j); END LOOP;
      END;
    `);
    expect(out).toMatch(/sum=15/);
    expect(out.indexOf('j=3')).toBeLessThan(out.indexOf('j=1'));
    sh.dispose();
  });

  it('WHILE loop with EXIT WHEN', () => {
    const sh = session(server('c5'));
    const out = block(sh, `
      DECLARE i NUMBER := 0;
      BEGIN
        WHILE TRUE LOOP
          i := i + 1;
          EXIT WHEN i >= 4;
        END LOOP;
        DBMS_OUTPUT.PUT_LINE('i=' || i);
      END;
    `);
    expect(out).toMatch(/i=4/);
    sh.dispose();
  });

  it('CONTINUE skips iterations', () => {
    const sh = session(server('c6'));
    const out = block(sh, `
      DECLARE s NUMBER := 0;
      BEGIN
        FOR i IN 1..5 LOOP
          CONTINUE WHEN MOD(i,2) = 0;
          s := s + i;
        END LOOP;
        DBMS_OUTPUT.PUT_LINE('odd=' || s);
      END;
    `);
    expect(out).toMatch(/odd=9/);
    sh.dispose();
  });

  it('labeled loop EXIT to outer', () => {
    const sh = session(server('c7'));
    const out = block(sh, `
      BEGIN
        <<outer>>
        FOR i IN 1..3 LOOP
          FOR j IN 1..3 LOOP
            EXIT outer WHEN i + j >= 3;
            DBMS_OUTPUT.PUT_LINE(i || ',' || j);
          END LOOP;
        END LOOP;
      END;
    `);
    expect(out).toMatch(/1,1/);
    expect(out).not.toMatch(/2,2/);
    sh.dispose();
  });
});

describe('PL/SQL exceptions', () => {
  it('catches ZERO_DIVIDE', () => {
    const sh = session(server('e1'));
    const out = block(sh, `
      DECLARE v NUMBER;
      BEGIN
        v := 1 / 0;
      EXCEPTION
        WHEN ZERO_DIVIDE THEN DBMS_OUTPUT.PUT_LINE('caught zero divide');
      END;
    `);
    expect(out).toMatch(/caught zero divide/);
    sh.dispose();
  });

  it('SELECT INTO with no rows raises NO_DATA_FOUND', () => {
    const sh = session(server('e2'));
    run(sh, 'CREATE TABLE NDF_T (id NUMBER);');
    const out = block(sh, `
      DECLARE v NUMBER;
      BEGIN
        SELECT id INTO v FROM NDF_T WHERE id = 99;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN DBMS_OUTPUT.PUT_LINE('no data');
      END;
    `);
    expect(out).toMatch(/no data/);
    sh.dispose();
  });

  it('user-defined exception with RAISE', () => {
    const sh = session(server('e3'));
    const out = block(sh, `
      DECLARE my_err EXCEPTION;
      BEGIN
        RAISE my_err;
      EXCEPTION
        WHEN my_err THEN DBMS_OUTPUT.PUT_LINE('user exception');
      END;
    `);
    expect(out).toMatch(/user exception/);
    sh.dispose();
  });

  it('PRAGMA EXCEPTION_INIT maps an error code', () => {
    const sh = session(server('e4'));
    const out = block(sh, `
      DECLARE
        custom EXCEPTION;
        PRAGMA EXCEPTION_INIT(custom, -20055);
      BEGIN
        RAISE_APPLICATION_ERROR(-20055, 'boom');
      EXCEPTION
        WHEN custom THEN DBMS_OUTPUT.PUT_LINE('mapped code caught');
      END;
    `);
    expect(out).toMatch(/mapped code caught/);
    sh.dispose();
  });

  it('WHEN OTHERS exposes SQLERRM and SQLCODE', () => {
    const sh = session(server('e5'));
    const out = block(sh, `
      BEGIN
        RAISE_APPLICATION_ERROR(-20001, 'Custom error');
      EXCEPTION
        WHEN OTHERS THEN DBMS_OUTPUT.PUT_LINE('code=' || SQLCODE || ' msg=' || SQLERRM);
      END;
    `);
    expect(out).toMatch(/code=-20001/);
    expect(out).toMatch(/Custom error/);
    sh.dispose();
  });

  it('unhandled exception surfaces ORA message', () => {
    const sh = session(server('e6'));
    const out = block(sh, `BEGIN RAISE_APPLICATION_ERROR(-20500, 'unhandled'); END;`);
    expect(out).toMatch(/ORA-20500/);
    expect(out).toMatch(/unhandled/);
    sh.dispose();
  });

  it('nested block propagates to outer handler', () => {
    const sh = session(server('e7'));
    const out = block(sh, `
      BEGIN
        BEGIN
          RAISE NO_DATA_FOUND;
        END;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN DBMS_OUTPUT.PUT_LINE('outer caught');
      END;
    `);
    expect(out).toMatch(/outer caught/);
    sh.dispose();
  });
});

describe('PL/SQL cursors', () => {
  beforeEach(() => {});

  it('explicit cursor OPEN/FETCH/CLOSE with attributes', () => {
    const sh = session(server('cur1'));
    run(sh, 'CREATE TABLE CUR_T (id NUMBER, nm VARCHAR2(10));');
    run(sh, "INSERT INTO CUR_T VALUES (1, 'a');");
    run(sh, "INSERT INTO CUR_T VALUES (2, 'b');");
    const out = block(sh, `
      DECLARE
        CURSOR c IS SELECT id, nm FROM CUR_T ORDER BY id;
        v_id NUMBER;
        v_nm VARCHAR2(10);
      BEGIN
        OPEN c;
        LOOP
          FETCH c INTO v_id, v_nm;
          EXIT WHEN c%NOTFOUND;
          DBMS_OUTPUT.PUT_LINE(v_id || ':' || v_nm);
        END LOOP;
        DBMS_OUTPUT.PUT_LINE('rows=' || c%ROWCOUNT);
        CLOSE c;
      END;
    `);
    expect(out).toMatch(/1:a/);
    expect(out).toMatch(/2:b/);
    expect(out).toMatch(/rows=2/);
    sh.dispose();
  });

  it('cursor FOR loop over a query', () => {
    const sh = session(server('cur2'));
    run(sh, 'CREATE TABLE CUR_F (id NUMBER);');
    run(sh, 'INSERT INTO CUR_F VALUES (10);');
    run(sh, 'INSERT INTO CUR_F VALUES (20);');
    const out = block(sh, `
      DECLARE total NUMBER := 0;
      BEGIN
        FOR r IN (SELECT id FROM CUR_F) LOOP
          total := total + r.id;
        END LOOP;
        DBMS_OUTPUT.PUT_LINE('total=' || total);
      END;
    `);
    expect(out).toMatch(/total=30/);
    sh.dispose();
  });

  it('parameterized cursor', () => {
    const sh = session(server('cur3'));
    run(sh, 'CREATE TABLE CUR_P (id NUMBER, grp NUMBER);');
    run(sh, 'INSERT INTO CUR_P VALUES (1, 5);');
    run(sh, 'INSERT INTO CUR_P VALUES (2, 5);');
    run(sh, 'INSERT INTO CUR_P VALUES (3, 9);');
    const out = block(sh, `
      DECLARE
        CURSOR c(p_grp NUMBER) IS SELECT id FROM CUR_P WHERE grp = p_grp;
        cnt NUMBER := 0;
        v NUMBER;
      BEGIN
        OPEN c(5);
        LOOP
          FETCH c INTO v;
          EXIT WHEN c%NOTFOUND;
          cnt := cnt + 1;
        END LOOP;
        CLOSE c;
        DBMS_OUTPUT.PUT_LINE('cnt=' || cnt);
      END;
    `);
    expect(out).toMatch(/cnt=2/);
    sh.dispose();
  });

  it('SQL%ROWCOUNT after DML', () => {
    const sh = session(server('cur4'));
    run(sh, 'CREATE TABLE RC_T (id NUMBER);');
    const out = block(sh, `
      BEGIN
        INSERT INTO RC_T VALUES (1);
        INSERT INTO RC_T VALUES (2);
        UPDATE RC_T SET id = id + 100;
        DBMS_OUTPUT.PUT_LINE('updated=' || SQL%ROWCOUNT);
      END;
    `);
    expect(out).toMatch(/updated=2/);
    sh.dispose();
  });
});

describe('PL/SQL collections and records', () => {
  it('associative array with COUNT/FIRST/LAST', () => {
    const sh = session(server('co1'));
    const out = block(sh, `
      DECLARE
        TYPE num_tab IS TABLE OF NUMBER INDEX BY PLS_INTEGER;
        t num_tab;
      BEGIN
        t(1) := 10;
        t(5) := 50;
        t(9) := 90;
        DBMS_OUTPUT.PUT_LINE('count=' || t.COUNT);
        DBMS_OUTPUT.PUT_LINE('first=' || t.FIRST || ' last=' || t.LAST);
        DBMS_OUTPUT.PUT_LINE('val5=' || t(5));
      END;
    `);
    expect(out).toMatch(/count=3/);
    expect(out).toMatch(/first=1 last=9/);
    expect(out).toMatch(/val5=50/);
    sh.dispose();
  });

  it('nested table EXTEND and iteration', () => {
    const sh = session(server('co2'));
    const out = block(sh, `
      DECLARE
        TYPE nt IS TABLE OF NUMBER;
        t nt := nt();
        s NUMBER := 0;
      BEGIN
        FOR i IN 1..3 LOOP
          t.EXTEND;
          t(i) := i * 10;
        END LOOP;
        FOR i IN 1..t.COUNT LOOP
          s := s + t(i);
        END LOOP;
        DBMS_OUTPUT.PUT_LINE('sum=' || s);
      END;
    `);
    expect(out).toMatch(/sum=60/);
    sh.dispose();
  });

  it('record type field access', () => {
    const sh = session(server('co3'));
    const out = block(sh, `
      DECLARE
        TYPE person IS RECORD (name VARCHAR2(20), age NUMBER);
        p person;
      BEGIN
        p.name := 'Alice';
        p.age := 30;
        DBMS_OUTPUT.PUT_LINE(p.name || ' is ' || p.age);
      END;
    `);
    expect(out).toMatch(/Alice is 30/);
    sh.dispose();
  });

  it('%ROWTYPE record from SELECT INTO', () => {
    const sh = session(server('co4'));
    run(sh, 'CREATE TABLE RT_T (id NUMBER, nm VARCHAR2(10));');
    run(sh, "INSERT INTO RT_T VALUES (7, 'seven');");
    const out = block(sh, `
      DECLARE r RT_T%ROWTYPE;
      BEGIN
        SELECT * INTO r FROM RT_T WHERE id = 7;
        DBMS_OUTPUT.PUT_LINE(r.id || '=' || r.nm);
      END;
    `);
    expect(out).toMatch(/7=seven/);
    sh.dispose();
  });

  it('BULK COLLECT INTO a collection', () => {
    const sh = session(server('co5'));
    run(sh, 'CREATE TABLE BC_T (id NUMBER);');
    run(sh, 'INSERT INTO BC_T VALUES (1);');
    run(sh, 'INSERT INTO BC_T VALUES (2);');
    run(sh, 'INSERT INTO BC_T VALUES (3);');
    const out = block(sh, `
      DECLARE
        TYPE nt IS TABLE OF NUMBER;
        t nt;
      BEGIN
        SELECT id BULK COLLECT INTO t FROM BC_T;
        DBMS_OUTPUT.PUT_LINE('n=' || t.COUNT);
      END;
    `);
    expect(out).toMatch(/n=3/);
    sh.dispose();
  });
});

describe('PL/SQL subprograms', () => {
  it('local function called in expression', () => {
    const sh = session(server('s1'));
    const out = block(sh, `
      DECLARE
        FUNCTION dbl(n NUMBER) RETURN NUMBER IS
        BEGIN
          RETURN n * 2;
        END;
      BEGIN
        DBMS_OUTPUT.PUT_LINE('r=' || dbl(21));
      END;
    `);
    expect(out).toMatch(/r=42/);
    sh.dispose();
  });

  it('local procedure with OUT parameter', () => {
    const sh = session(server('s2'));
    const out = block(sh, `
      DECLARE
        v NUMBER;
        PROCEDURE setit(x OUT NUMBER) IS
        BEGIN
          x := 77;
        END;
      BEGIN
        setit(v);
        DBMS_OUTPUT.PUT_LINE('v=' || v);
      END;
    `);
    expect(out).toMatch(/v=77/);
    sh.dispose();
  });

  it('recursive local function', () => {
    const sh = session(server('s3'));
    const out = block(sh, `
      DECLARE
        FUNCTION fact(n NUMBER) RETURN NUMBER IS
        BEGIN
          IF n <= 1 THEN RETURN 1; END IF;
          RETURN n * fact(n - 1);
        END;
      BEGIN
        DBMS_OUTPUT.PUT_LINE('5!=' || fact(5));
      END;
    `);
    expect(out).toMatch(/5!=120/);
    sh.dispose();
  });

  it('stored function invoked from a block', () => {
    const sh = session(server('s4'));
    run(sh, `CREATE OR REPLACE FUNCTION tripler(p NUMBER) RETURN NUMBER AS BEGIN RETURN p * 3; END;`);
    const out = block(sh, `
      BEGIN
        DBMS_OUTPUT.PUT_LINE('t=' || tripler(4));
      END;
    `);
    expect(out).toMatch(/t=12/);
    sh.dispose();
  });

  it('stored procedure performs DML callable via block', () => {
    const sh = session(server('s5'));
    run(sh, 'CREATE TABLE SP_T (id NUMBER);');
    run(sh, `CREATE OR REPLACE PROCEDURE addrow(p NUMBER) AS BEGIN INSERT INTO SP_T VALUES (p); END;`);
    block(sh, `BEGIN addrow(1); addrow(2); END;`);
    const out = run(sh, 'SELECT COUNT(*) FROM SP_T;');
    expect(out).toMatch(/2/);
    sh.dispose();
  });
});

describe('PL/SQL dynamic SQL and built-ins', () => {
  it('EXECUTE IMMEDIATE with USING bind and INTO', () => {
    const sh = session(server('d1'));
    run(sh, 'CREATE TABLE EI_U (id NUMBER, nm VARCHAR2(10));');
    run(sh, "INSERT INTO EI_U VALUES (1, 'x');");
    run(sh, "INSERT INTO EI_U VALUES (2, 'y');");
    const out = block(sh, `
      DECLARE v VARCHAR2(10);
      BEGIN
        EXECUTE IMMEDIATE 'SELECT nm FROM EI_U WHERE id = :1' INTO v USING 2;
        DBMS_OUTPUT.PUT_LINE('got=' || v);
      END;
    `);
    expect(out).toMatch(/got=y/);
    sh.dispose();
  });

  it('built-in string functions', () => {
    const sh = session(server('d2'));
    const out = block(sh, `
      BEGIN
        DBMS_OUTPUT.PUT_LINE(UPPER('abc') || '-' || SUBSTR('hello', 2, 3) || '-' || LENGTH('test'));
        DBMS_OUTPUT.PUT_LINE(NVL(NULL, 'def') || '-' || LPAD('5', 3, '0'));
      END;
    `);
    expect(out).toMatch(/ABC-ell-4/);
    expect(out).toMatch(/def-005/);
    sh.dispose();
  });

  it('INSTR supports occurrence and backward search via shared registry', () => {
    const sh = session(server('d2b'));
    const out = block(sh, `
      BEGIN
        DBMS_OUTPUT.PUT_LINE(INSTR('BANANA', 'A', 1, 2) || '-' || INSTR('BANANA', 'A', -1));
      END;
    `);
    expect(out).toMatch(/4-6/);
    sh.dispose();
  });

  it('LPAD truncates and INITCAP lowercases word tails via shared registry', () => {
    const sh = session(server('d2c'));
    const out = block(sh, `
      BEGIN
        DBMS_OUTPUT.PUT_LINE(LPAD('hello', 3) || '-' || INITCAP('heLLo woRLD'));
      END;
    `);
    expect(out).toMatch(/hel-Hello World/);
    sh.dispose();
  });

  it('GREATEST and LEAST propagate NULL like Oracle', () => {
    const sh = session(server('d2d'));
    const out = block(sh, `
      BEGIN
        DBMS_OUTPUT.PUT_LINE(NVL(GREATEST(1, NULL, 3), -1) || '-' || NVL(LEAST(NULL, 5), -1));
      END;
    `);
    expect(out).toMatch(/-1--1/);
    sh.dispose();
  });

  it('DECODE treats two NULLs as a match like Oracle', () => {
    const sh = session(server('d2e'));
    const out = block(sh, `
      BEGIN
        DBMS_OUTPUT.PUT_LINE(DECODE(NULL, 1, 'one', NULL, 'null-match', 'default'));
      END;
    `);
    expect(out).toMatch(/null-match/);
    sh.dispose();
  });

  it('bind variable interpolation in static SQL INSERT', () => {
    const sh = session(server('d3'));
    run(sh, 'CREATE TABLE BV_T (id NUMBER, nm VARCHAR2(20));');
    block(sh, `
      DECLARE
        v_id NUMBER := 42;
        v_nm VARCHAR2(20) := 'answer';
      BEGIN
        INSERT INTO BV_T (id, nm) VALUES (v_id, v_nm);
      END;
    `);
    const out = run(sh, 'SELECT id, nm FROM BV_T;');
    expect(out).toMatch(/42\s+answer/);
    sh.dispose();
  });
});

describe('DBMS_OUTPUT — PUT / NEW_LINE / ENABLE / DISABLE buffering', () => {
  it('PUT accumulates into a partial line that NEW_LINE finalizes', () => {
    const sh = session(server('out-1'));
    sh.processLine('BEGIN');
    sh.processLine("DBMS_OUTPUT.PUT('a');");
    sh.processLine("DBMS_OUTPUT.PUT('b');");
    sh.processLine("DBMS_OUTPUT.PUT('c');");
    sh.processLine('DBMS_OUTPUT.NEW_LINE;');
    sh.processLine("DBMS_OUTPUT.PUT_LINE('next');");
    sh.processLine('END;');
    const out = sh.processLine('/').output.join('\n');
    expect(out).toContain('abc');
    expect(out).toContain('next');
    sh.dispose();
  });

  it('PUT_LINE flushes a pending partial buffer in front of the new line', () => {
    const sh = session(server('out-2'));
    sh.processLine('BEGIN');
    sh.processLine("DBMS_OUTPUT.PUT('prefix=');");
    sh.processLine("DBMS_OUTPUT.PUT_LINE('VALUE');");
    sh.processLine('END;');
    const out = sh.processLine('/').output.join('\n');
    expect(out).toContain('prefix=VALUE');
    sh.dispose();
  });

  it('PUT followed by PUT joins on the same line even without NEW_LINE', () => {
    const sh = session(server('out-3'));
    sh.processLine('BEGIN');
    sh.processLine("DBMS_OUTPUT.PUT('first');");
    sh.processLine("DBMS_OUTPUT.PUT('-second');");
    sh.processLine("DBMS_OUTPUT.PUT_LINE('-third');");
    sh.processLine('END;');
    const out = sh.processLine('/').output.join('\n');
    expect(out).toContain('first-second-third');
    sh.dispose();
  });
});

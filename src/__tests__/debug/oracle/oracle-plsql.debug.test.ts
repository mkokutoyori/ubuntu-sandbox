/**
 * Debug — PL/SQL Oracle.
 *
 * Anonymous blocks, procedures, functions, packages, triggers, cursors,
 * exceptions, bulk collect, FORALL, autonomous transactions, types,
 * collections, pipelined functions, PRAGMA.
 */

import { describe, it, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { removeOracleDatabase, getOracleDatabase } from '@/terminal/commands/database';
import { createSqlPlusRunner, runOracleDump, type OracleDebugLine } from './_oracle-dump';
import { monitoringSweep } from './_padding';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

describe('debug — Oracle PL/SQL', () => {
  it('parcourt anonymous blocks, procedures, functions, packages, triggers, cursors, exceptions', () => {
    const srv = new LinuxServer('linux-server', 'ora-plsql', 100, 100);
    getOracleDatabase(srv.id);
    const runner = createSqlPlusRunner(srv);

    const lines: OracleDebugLine[] = [
      // ── 1. setup ─────────────────────────────────────────────────
      { section: 'setup', cmd: 'CREATE USER plsql IDENTIFIED BY "Plsql1#" QUOTA UNLIMITED ON users;' },
      'GRANT CREATE SESSION, CREATE TABLE, CREATE PROCEDURE, CREATE TRIGGER, CREATE TYPE, CREATE SEQUENCE TO plsql;',
      'ALTER SESSION SET CURRENT_SCHEMA = plsql;',
      'SET SERVEROUTPUT ON;',
      'SET SERVEROUTPUT ON SIZE UNLIMITED;',
      'SET SERVEROUTPUT ON FORMAT WRAPPED;',
      'CREATE TABLE log_msg (ts TIMESTAMP DEFAULT SYSTIMESTAMP, level VARCHAR2(10), msg VARCHAR2(4000));',
      'CREATE TABLE accounts (id NUMBER PRIMARY KEY, balance NUMBER(15,2));',
      'INSERT INTO accounts VALUES (1, 1000); INSERT INTO accounts VALUES (2, 2000); INSERT INTO accounts VALUES (3, 500);',
      'COMMIT;',

      // ── 2. anonymous PL/SQL blocks ───────────────────────────────
      { section: 'anonymous blocks', cmd:
        "BEGIN DBMS_OUTPUT.PUT_LINE('Hello PL/SQL'); END;" },
      "DECLARE v_msg VARCHAR2(100) := 'World'; BEGIN DBMS_OUTPUT.PUT_LINE('Hello ' || v_msg); END;",
      "DECLARE v_n NUMBER := 10; v_sum NUMBER := 0; BEGIN FOR i IN 1..v_n LOOP v_sum := v_sum + i; END LOOP; DBMS_OUTPUT.PUT_LINE('Sum=' || v_sum); END;",
      "DECLARE v_i NUMBER := 0; BEGIN WHILE v_i < 5 LOOP v_i := v_i + 1; DBMS_OUTPUT.PUT_LINE(v_i); END LOOP; END;",
      "DECLARE v_i NUMBER := 0; BEGIN LOOP v_i := v_i + 1; EXIT WHEN v_i > 5; DBMS_OUTPUT.PUT_LINE(v_i); END LOOP; END;",
      "DECLARE v_n NUMBER; BEGIN SELECT COUNT(*) INTO v_n FROM accounts; DBMS_OUTPUT.PUT_LINE('Accounts: ' || v_n); END;",
      "DECLARE v_row accounts%ROWTYPE; BEGIN SELECT * INTO v_row FROM accounts WHERE id = 1; DBMS_OUTPUT.PUT_LINE('Bal: ' || v_row.balance); END;",
      "DECLARE v_bal accounts.balance%TYPE; BEGIN SELECT balance INTO v_bal FROM accounts WHERE id = 1; DBMS_OUTPUT.PUT_LINE('Bal: ' || v_bal); END;",
      // conditional
      "BEGIN IF SYSDATE > DATE '2020-01-01' THEN DBMS_OUTPUT.PUT_LINE('past 2020'); ELSE DBMS_OUTPUT.PUT_LINE('not yet'); END IF; END;",
      "DECLARE v_grade CHAR := 'A'; BEGIN CASE v_grade WHEN 'A' THEN DBMS_OUTPUT.PUT_LINE('Excellent'); WHEN 'B' THEN DBMS_OUTPUT.PUT_LINE('Good'); ELSE DBMS_OUTPUT.PUT_LINE('OK'); END CASE; END;",
      // continue
      "BEGIN FOR i IN 1..10 LOOP CONTINUE WHEN MOD(i,2)=0; DBMS_OUTPUT.PUT_LINE(i); END LOOP; END;",
      // goto
      "BEGIN <<top>> NULL; DBMS_OUTPUT.PUT_LINE('hi'); END;",

      // ── 3. cursors ───────────────────────────────────────────────
      { section: 'explicit cursors', cmd:
        "DECLARE CURSOR c IS SELECT id, balance FROM accounts ORDER BY id; v_id accounts.id%TYPE; v_bal accounts.balance%TYPE; BEGIN OPEN c; LOOP FETCH c INTO v_id, v_bal; EXIT WHEN c%NOTFOUND; DBMS_OUTPUT.PUT_LINE(v_id || ':' || v_bal); END LOOP; CLOSE c; END;" },
      "DECLARE CURSOR c IS SELECT * FROM accounts; BEGIN FOR r IN c LOOP DBMS_OUTPUT.PUT_LINE(r.id || ':' || r.balance); END LOOP; END;",
      "BEGIN FOR r IN (SELECT * FROM accounts) LOOP DBMS_OUTPUT.PUT_LINE(r.id || ':' || r.balance); END LOOP; END;",
      // parameterized cursor
      "DECLARE CURSOR c(p_min NUMBER) IS SELECT id FROM accounts WHERE balance > p_min; BEGIN FOR r IN c(800) LOOP DBMS_OUTPUT.PUT_LINE(r.id); END LOOP; END;",
      // ref cursor
      "DECLARE TYPE rc IS REF CURSOR; v_c rc; v_id NUMBER; BEGIN OPEN v_c FOR SELECT id FROM accounts; LOOP FETCH v_c INTO v_id; EXIT WHEN v_c%NOTFOUND; DBMS_OUTPUT.PUT_LINE(v_id); END LOOP; CLOSE v_c; END;",
      "DECLARE v_c SYS_REFCURSOR; v_id NUMBER; BEGIN OPEN v_c FOR SELECT id FROM accounts; LOOP FETCH v_c INTO v_id; EXIT WHEN v_c%NOTFOUND; DBMS_OUTPUT.PUT_LINE(v_id); END LOOP; CLOSE v_c; END;",

      // ── 4. BULK COLLECT / FORALL ─────────────────────────────────
      { section: 'BULK COLLECT', cmd:
        "DECLARE TYPE t_ids IS TABLE OF NUMBER; v_ids t_ids; BEGIN SELECT id BULK COLLECT INTO v_ids FROM accounts; FOR i IN 1..v_ids.COUNT LOOP DBMS_OUTPUT.PUT_LINE(v_ids(i)); END LOOP; END;" },
      "DECLARE TYPE t_rows IS TABLE OF accounts%ROWTYPE; v_rows t_rows; BEGIN SELECT * BULK COLLECT INTO v_rows FROM accounts; DBMS_OUTPUT.PUT_LINE(v_rows.COUNT || ' rows'); END;",
      // BULK COLLECT LIMIT
      "DECLARE CURSOR c IS SELECT id FROM accounts; TYPE t IS TABLE OF NUMBER; v t; BEGIN OPEN c; LOOP FETCH c BULK COLLECT INTO v LIMIT 2; EXIT WHEN v.COUNT = 0; DBMS_OUTPUT.PUT_LINE('batch ' || v.COUNT); END LOOP; CLOSE c; END;",
      // FORALL
      "DECLARE TYPE t IS TABLE OF NUMBER; v_ids t := t(10, 20, 30); BEGIN FORALL i IN 1..v_ids.COUNT INSERT INTO accounts (id, balance) VALUES (v_ids(i), v_ids(i) * 10); COMMIT; END;",
      "DECLARE TYPE t IS TABLE OF NUMBER; v_ids t := t(10, 20, 30); BEGIN FORALL i IN 1..v_ids.COUNT SAVE EXCEPTIONS UPDATE accounts SET balance = balance + 1 WHERE id = v_ids(i); END;",
      // associative array
      "DECLARE TYPE map_t IS TABLE OF VARCHAR2(100) INDEX BY VARCHAR2(20); m map_t; BEGIN m('one') := 'first'; m('two') := 'second'; DBMS_OUTPUT.PUT_LINE(m('one')); END;",
      // varray
      "DECLARE TYPE va IS VARRAY(5) OF NUMBER; v va := va(1,2,3); BEGIN DBMS_OUTPUT.PUT_LINE(v(1)); v.EXTEND; v(4) := 4; DBMS_OUTPUT.PUT_LINE(v.COUNT); END;",

      // ── 5. EXCEPTIONS ────────────────────────────────────────────
      { section: 'exceptions', cmd:
        "BEGIN RAISE_APPLICATION_ERROR(-20001, 'Custom error'); EXCEPTION WHEN OTHERS THEN DBMS_OUTPUT.PUT_LINE('Caught: ' || SQLERRM); END;" },
      "DECLARE v NUMBER; BEGIN SELECT balance INTO v FROM accounts WHERE id = 999999; EXCEPTION WHEN NO_DATA_FOUND THEN DBMS_OUTPUT.PUT_LINE('No data'); WHEN TOO_MANY_ROWS THEN DBMS_OUTPUT.PUT_LINE('Too many'); WHEN OTHERS THEN DBMS_OUTPUT.PUT_LINE('Other: ' || SQLERRM); END;",
      "DECLARE e_custom EXCEPTION; PRAGMA EXCEPTION_INIT(e_custom, -20100); BEGIN RAISE e_custom; EXCEPTION WHEN e_custom THEN DBMS_OUTPUT.PUT_LINE('Custom caught'); END;",
      "BEGIN INSERT INTO accounts VALUES (1, 999); EXCEPTION WHEN DUP_VAL_ON_INDEX THEN DBMS_OUTPUT.PUT_LINE('Dup'); END;",
      "BEGIN BEGIN RAISE PROGRAM_ERROR; EXCEPTION WHEN PROGRAM_ERROR THEN RAISE; END; EXCEPTION WHEN OTHERS THEN DBMS_OUTPUT.PUT_LINE('Outer caught: ' || SQLCODE); END;",
      "BEGIN NULL; EXCEPTION WHEN OTHERS THEN DBMS_OUTPUT.PUT_LINE(DBMS_UTILITY.FORMAT_ERROR_BACKTRACE); END;",
      "BEGIN NULL; EXCEPTION WHEN OTHERS THEN DBMS_OUTPUT.PUT_LINE(DBMS_UTILITY.FORMAT_CALL_STACK); END;",

      // ── 6. PROCEDURES ────────────────────────────────────────────
      { section: 'procedures', cmd:
        "CREATE OR REPLACE PROCEDURE transfer(p_from NUMBER, p_to NUMBER, p_amount NUMBER) IS BEGIN UPDATE accounts SET balance = balance - p_amount WHERE id = p_from; UPDATE accounts SET balance = balance + p_amount WHERE id = p_to; COMMIT; END;" },
      "EXEC transfer(1, 2, 50);",
      "BEGIN transfer(2, 1, 25); END;",
      "CREATE OR REPLACE PROCEDURE get_balance(p_id IN NUMBER, p_bal OUT NUMBER) IS BEGIN SELECT balance INTO p_bal FROM accounts WHERE id = p_id; END;",
      "DECLARE v NUMBER; BEGIN get_balance(1, v); DBMS_OUTPUT.PUT_LINE(v); END;",
      "CREATE OR REPLACE PROCEDURE log_msg(p_level VARCHAR2, p_msg VARCHAR2) IS PRAGMA AUTONOMOUS_TRANSACTION; BEGIN INSERT INTO log_msg (level, msg) VALUES (p_level, p_msg); COMMIT; END;",
      "EXEC log_msg('INFO', 'Procedure invoked');",
      "EXEC log_msg('WARN', 'Sample warning');",
      "EXEC log_msg('ERROR', 'Demo error');",
      "DROP PROCEDURE transfer;",
      "DROP PROCEDURE get_balance;",

      // ── 7. FUNCTIONS ─────────────────────────────────────────────
      { section: 'functions', cmd:
        "CREATE OR REPLACE FUNCTION balance_of(p_id NUMBER) RETURN NUMBER IS v NUMBER; BEGIN SELECT balance INTO v FROM accounts WHERE id = p_id; RETURN v; END;" },
      "SELECT balance_of(1) FROM dual;",
      "SELECT id, balance_of(id) AS bal FROM accounts;",
      "CREATE OR REPLACE FUNCTION add_n(a NUMBER, b NUMBER) RETURN NUMBER DETERMINISTIC IS BEGIN RETURN a + b; END;",
      "SELECT add_n(2, 3) FROM dual;",
      "CREATE OR REPLACE FUNCTION fib(n NUMBER) RETURN NUMBER IS BEGIN IF n <= 1 THEN RETURN n; END IF; RETURN fib(n-1) + fib(n-2); END;",
      "SELECT fib(10) FROM dual;",
      "DROP FUNCTION balance_of;",
      "DROP FUNCTION add_n;",
      "DROP FUNCTION fib;",

      // ── 8. PACKAGES ──────────────────────────────────────────────
      { section: 'packages', cmd:
        "CREATE OR REPLACE PACKAGE bank IS PROCEDURE deposit(p_id NUMBER, p_amount NUMBER); PROCEDURE withdraw(p_id NUMBER, p_amount NUMBER); FUNCTION balance(p_id NUMBER) RETURN NUMBER; END bank;" },
      "CREATE OR REPLACE PACKAGE BODY bank IS PROCEDURE deposit(p_id NUMBER, p_amount NUMBER) IS BEGIN UPDATE accounts SET balance = balance + p_amount WHERE id = p_id; END; PROCEDURE withdraw(p_id NUMBER, p_amount NUMBER) IS BEGIN UPDATE accounts SET balance = balance - p_amount WHERE id = p_id; END; FUNCTION balance(p_id NUMBER) RETURN NUMBER IS v NUMBER; BEGIN SELECT balance INTO v FROM accounts WHERE id = p_id; RETURN v; END; END bank;",
      "EXEC bank.deposit(1, 100);",
      "EXEC bank.withdraw(1, 50);",
      "SELECT bank.balance(1) FROM dual;",
      "ALTER PACKAGE bank COMPILE;",
      "ALTER PACKAGE bank COMPILE BODY;",
      "ALTER PACKAGE bank COMPILE SPECIFICATION;",
      "ALTER PACKAGE bank COMPILE PLSQL_OPTIMIZE_LEVEL=2;",
      "ALTER PACKAGE bank COMPILE DEBUG;",
      "SELECT * FROM user_source WHERE name = 'BANK';",
      "SELECT * FROM user_procedures WHERE object_name = 'BANK';",
      "SELECT * FROM user_arguments WHERE package_name = 'BANK';",
      "DROP PACKAGE BODY bank;",
      "DROP PACKAGE bank;",

      // ── 9. TRIGGERS ──────────────────────────────────────────────
      { section: 'triggers', cmd:
        "CREATE OR REPLACE TRIGGER trg_audit_balance AFTER UPDATE OF balance ON accounts FOR EACH ROW BEGIN INSERT INTO log_msg (level, msg) VALUES ('AUDIT', 'balance ' || :OLD.balance || ' → ' || :NEW.balance || ' for ' || :NEW.id); END;" },
      "UPDATE accounts SET balance = balance + 10 WHERE id = 1;",
      "UPDATE accounts SET balance = balance + 10 WHERE id = 1;",
      "SELECT * FROM log_msg WHERE level = 'AUDIT' ORDER BY ts;",
      'COMMIT;',
      "CREATE OR REPLACE TRIGGER trg_before_insert BEFORE INSERT ON accounts FOR EACH ROW BEGIN :NEW.balance := NVL(:NEW.balance, 0); END;",
      "CREATE OR REPLACE TRIGGER trg_compound FOR INSERT ON accounts COMPOUND TRIGGER BEFORE EACH ROW IS BEGIN NULL; END BEFORE EACH ROW; AFTER STATEMENT IS BEGIN NULL; END AFTER STATEMENT; END trg_compound;",
      "CREATE OR REPLACE TRIGGER trg_logon AFTER LOGON ON DATABASE BEGIN NULL; END;",
      "CREATE OR REPLACE TRIGGER trg_logoff BEFORE LOGOFF ON DATABASE BEGIN NULL; END;",
      "CREATE OR REPLACE TRIGGER trg_ddl AFTER DDL ON SCHEMA BEGIN NULL; END;",
      "CREATE OR REPLACE TRIGGER trg_servererror AFTER SERVERERROR ON DATABASE BEGIN NULL; END;",
      "ALTER TRIGGER trg_audit_balance DISABLE;",
      "ALTER TRIGGER trg_audit_balance ENABLE;",
      "ALTER TABLE accounts DISABLE ALL TRIGGERS;",
      "ALTER TABLE accounts ENABLE ALL TRIGGERS;",
      "DROP TRIGGER trg_compound;",
      "DROP TRIGGER trg_logon;",
      "DROP TRIGGER trg_logoff;",
      "DROP TRIGGER trg_ddl;",
      "DROP TRIGGER trg_servererror;",
      "DROP TRIGGER trg_before_insert;",
      "DROP TRIGGER trg_audit_balance;",

      // ── 10. TYPES + COLLECTIONS ─────────────────────────────────
      { section: 'object types', cmd:
        "CREATE OR REPLACE TYPE addr_t AS OBJECT (street VARCHAR2(100), city VARCHAR2(50), zip VARCHAR2(10));" },
      "CREATE OR REPLACE TYPE addrs_t AS TABLE OF addr_t;",
      "CREATE OR REPLACE TYPE phones_t AS VARRAY(5) OF VARCHAR2(20);",
      "DECLARE v addr_t := addr_t('1 Rue de Paris', 'Paris', '75001'); BEGIN DBMS_OUTPUT.PUT_LINE(v.city); END;",
      "DECLARE v phones_t := phones_t('555-0101', '555-0202'); BEGIN DBMS_OUTPUT.PUT_LINE(v(1)); END;",
      "DROP TYPE addrs_t FORCE;",
      "DROP TYPE addr_t FORCE;",
      "DROP TYPE phones_t FORCE;",

      // ── 11. PIPELINED FUNCTIONS ─────────────────────────────────
      { section: 'pipelined functions', cmd:
        "CREATE OR REPLACE TYPE num_tab AS TABLE OF NUMBER;" },
      "CREATE OR REPLACE FUNCTION gen_n(p_n NUMBER) RETURN num_tab PIPELINED IS BEGIN FOR i IN 1..p_n LOOP PIPE ROW (i); END LOOP; RETURN; END;",
      "SELECT * FROM TABLE(gen_n(5));",
      "SELECT COUNT(*) FROM TABLE(gen_n(100));",
      "DROP FUNCTION gen_n;",
      "DROP TYPE num_tab FORCE;",

      // ── 12. PRAGMA ───────────────────────────────────────────────
      { section: 'PRAGMA', cmd:
        "CREATE OR REPLACE PROCEDURE log_autonomous(p_msg VARCHAR2) IS PRAGMA AUTONOMOUS_TRANSACTION; BEGIN INSERT INTO log_msg (level, msg) VALUES ('AUTO', p_msg); COMMIT; END;" },
      "EXEC log_autonomous('autonomous insert');",
      "EXEC log_autonomous('another autonomous insert');",
      "SELECT msg FROM log_msg WHERE level = 'AUTO';",
      "DROP PROCEDURE log_autonomous;",
      "CREATE OR REPLACE FUNCTION pure_func(a NUMBER, b NUMBER) RETURN NUMBER IS BEGIN RETURN a + b; END;",
      "DROP FUNCTION pure_func;",
      "CREATE OR REPLACE FUNCTION det_func(a NUMBER) RETURN NUMBER DETERMINISTIC IS BEGIN RETURN a * 2; END;",
      "DROP FUNCTION det_func;",

      // ── 13. INVOKERS RIGHTS ──────────────────────────────────────
      { section: "AUTHID", cmd:
        "CREATE OR REPLACE PROCEDURE def_rights AUTHID DEFINER IS BEGIN NULL; END;" },
      "CREATE OR REPLACE PROCEDURE invk_rights AUTHID CURRENT_USER IS BEGIN NULL; END;",
      "DROP PROCEDURE def_rights;",
      "DROP PROCEDURE invk_rights;",

      // ── 14. INSPECT PROGRAMS ─────────────────────────────────────
      { section: 'inspect PL/SQL', cmd: "SELECT * FROM user_source ORDER BY name, type, line FETCH FIRST 50 ROWS ONLY;" },
      "SELECT name, type, line, text FROM user_source WHERE type = 'PROCEDURE' AND rownum < 30;",
      "SELECT object_name, object_type, status FROM user_objects WHERE object_type IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TRIGGER','TYPE');",
      "SELECT * FROM user_errors;",
      "SELECT * FROM user_dependencies;",
      "SELECT * FROM user_dependencies WHERE referenced_name = 'ACCOUNTS';",
      "SELECT * FROM user_arguments WHERE rownum < 30;",
      "SELECT * FROM user_procedures WHERE rownum < 30;",
      "SELECT * FROM user_triggers;",
      "SELECT * FROM user_trigger_cols;",
      "SELECT * FROM user_plsql_object_settings;",
      "SELECT * FROM user_stored_settings;",
      "SELECT * FROM user_identifiers WHERE rownum < 30;",
      "SELECT * FROM user_statements WHERE rownum < 30;",

      // ── 15. DBMS_OUTPUT manipulation ─────────────────────────────
      { section: 'DBMS_OUTPUT', cmd: 'SET SERVEROUTPUT OFF;' },
      "BEGIN DBMS_OUTPUT.PUT_LINE('hidden'); END;",
      'SET SERVEROUTPUT ON;',
      "BEGIN DBMS_OUTPUT.PUT_LINE('visible'); END;",
      "EXEC DBMS_OUTPUT.ENABLE(1000000);",
      "EXEC DBMS_OUTPUT.DISABLE;",
      "EXEC DBMS_OUTPUT.ENABLE;",

      // ── 16. DBMS_SQL dynamic ─────────────────────────────────────
      { section: 'dynamic SQL', cmd:
        "BEGIN EXECUTE IMMEDIATE 'INSERT INTO accounts VALUES (:1, :2)' USING 99, 999; END;" },
      "DECLARE v NUMBER; BEGIN EXECUTE IMMEDIATE 'SELECT balance FROM accounts WHERE id = :1' INTO v USING 99; DBMS_OUTPUT.PUT_LINE(v); END;",
      "BEGIN EXECUTE IMMEDIATE 'TRUNCATE TABLE log_msg'; END;",
      "DECLARE c NUMBER := DBMS_SQL.OPEN_CURSOR; BEGIN DBMS_SQL.PARSE(c, 'SELECT id FROM accounts', DBMS_SQL.NATIVE); DBMS_SQL.CLOSE_CURSOR(c); END;",

      // ── 17. UTL_FILE / FILE handlers ────────────────────────────
      { section: 'UTL_FILE', cmd:
        "DECLARE f UTL_FILE.FILE_TYPE; BEGIN f := UTL_FILE.FOPEN('TMP_DIR', 'out.txt', 'W'); UTL_FILE.PUT_LINE(f, 'hello'); UTL_FILE.FCLOSE(f); END;" },
      "DECLARE f UTL_FILE.FILE_TYPE; line VARCHAR2(4000); BEGIN f := UTL_FILE.FOPEN('TMP_DIR', 'out.txt', 'R'); UTL_FILE.GET_LINE(f, line); DBMS_OUTPUT.PUT_LINE(line); UTL_FILE.FCLOSE(f); END;",

      // ── 18. UTL_HTTP / network ──────────────────────────────────
      { section: 'UTL_HTTP', cmd:
        "DECLARE r UTL_HTTP.REQ; BEGIN r := UTL_HTTP.BEGIN_REQUEST('http://example.com/'); UTL_HTTP.END_REQUEST(r); END;" },

      // ── 19. cleanup ─────────────────────────────────────────────
      { section: 'cleanup', cmd: 'DROP TABLE log_msg PURGE;' },
      'DROP TABLE accounts PURGE;',
      'ALTER SESSION SET CURRENT_SCHEMA = SYS;',
      'DROP USER plsql CASCADE;',
      ...monitoringSweep('plsql'),
      'EXIT;',
    ];

    runOracleDump('oracle-plsql', 'LinuxServer ora-plsql — Oracle ORCL OPEN', lines, runner);
    runner.dispose();
    removeOracleDatabase(srv.id);
  });
});

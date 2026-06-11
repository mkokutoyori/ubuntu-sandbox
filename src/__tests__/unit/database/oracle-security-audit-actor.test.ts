/**
 * End-to-end SQL-driven tests for the reactive security-audit
 * subsystem (SecurityAuditActor + AuditJournal + native Oracle views).
 *
 * Every assertion goes through SQL*Plus — either a SELECT against a
 * native Oracle 19c view or a SECDEMO command — so we exercise the
 * exact path a DBA would use.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { ORACLE_CONFIG } from '@/database/oracle/OracleConfig';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function newSession(name: string): SqlPlusSubShell {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}

function run(sh: SqlPlusSubShell, sql: string): string {
  return sh.processLine(sql).output.join('\n');
}

describe('security audit — connection traces', () => {
  it('UNIFIED_AUDIT_TRAIL records the SYSDBA logon', () => {
    const sh = newSession('sec-conn-1');
    const out = run(sh, `SELECT DBUSERNAME, ACTION_NAME FROM UNIFIED_AUDIT_TRAIL WHERE DBUSERNAME='SYS';`);
    expect(out).toMatch(/SYS/);
    expect(out).toMatch(/LOGON/);
    sh.dispose();
  });

  it('DBA_USERS.LAST_LOGIN is populated after a successful logon', () => {
    const sh = newSession('sec-conn-2');
    const out = run(sh, `SELECT USERNAME, LAST_LOGIN FROM DBA_USERS WHERE USERNAME='SYS';`);
    expect(out).toMatch(/SYS/);
    expect(out).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    sh.dispose();
  });

  it('writes a .aud file under adump/ for every successful connection', () => {
    const sh = newSession('sec-conn-3');
    const ls = run(sh, `HOST ls ${ORACLE_CONFIG.AUDIT_DIR}`);
    expect(ls).toMatch(/\.aud/);
    sh.dispose();
  });
});

describe('security audit — DDL / DML history (V$LOGMNR_CONTENTS)', () => {
  it('records DDL executed via SQL*Plus', () => {
    const sh = newSession('sec-ddl-1');
    sh.processLine('CREATE TABLE T1 (id NUMBER);');
    const out = run(sh, `SELECT OPERATION, TABLE_NAME FROM V$LOGMNR_CONTENTS;`);
    expect(out).toMatch(/T1/);
    expect(out).toMatch(/DDL/);
    sh.dispose();
  });

  it('records DML executed via SQL*Plus', () => {
    const sh = newSession('sec-dml-1');
    sh.processLine('CREATE TABLE T2 (id NUMBER);');
    sh.processLine('INSERT INTO T2 VALUES (1);');
    const out = run(sh, `SELECT OPERATION, TABLE_NAME FROM V$LOGMNR_CONTENTS;`);
    expect(out).toMatch(/T2/);
    sh.dispose();
  });
});

describe('security audit — privilege usage', () => {
  it('DBA_USED_SYSPRIVS lists CREATE SESSION after a logon', () => {
    const sh = newSession('sec-priv-1');
    const out = run(sh, `SELECT USERNAME, SYS_PRIV FROM DBA_USED_SYSPRIVS;`);
    expect(out).toMatch(/CREATE SESSION/);
    sh.dispose();
  });

  it('DBA_PRIV_CAPTURES lists the implicit ORA_$DEPENDENCY capture', () => {
    const sh = newSession('sec-priv-2');
    const out = run(sh, `SELECT NAME, ENABLED FROM DBA_PRIV_CAPTURES;`);
    expect(out).toMatch(/ORA_\$DEPENDENCY/);
    expect(out).toMatch(/YES/);
    sh.dispose();
  });

  it('DBA_UNUSED_SYSPRIVS reveals privileges that were never exercised', () => {
    const sh = newSession('sec-priv-3');
    // HR has plenty of granted-but-unused system privileges out of the box.
    const out = run(sh, `SELECT USERNAME, SYS_PRIV FROM DBA_UNUSED_SYSPRIVS WHERE USERNAME='HR';`);
    expect(out).toMatch(/HR/);
    sh.dispose();
  });
});

describe('security audit — sensitive data registry (TSDP)', () => {
  it('DBA_SENSITIVE_COLUMNS lists HR.EMPLOYEES.SALARY', () => {
    const sh = newSession('sec-tsdp-1');
    const out = run(sh, `SELECT OWNER, TABLE_NAME, COLUMN_NAME, TYPE FROM DBA_SENSITIVE_COLUMNS WHERE OWNER='HR';`);
    expect(out).toMatch(/EMPLOYEES/);
    expect(out).toMatch(/SALARY/);
    expect(out).toMatch(/PII/);
    sh.dispose();
  });

  it('DBA_SENSITIVE_COLUMN_TYPES surfaces the built-in CREDIT_CARD_NUMBER', () => {
    const sh = newSession('sec-tsdp-2');
    const out = run(sh, `SELECT NAME, PRE_DEFINED FROM DBA_SENSITIVE_COLUMN_TYPES;`);
    expect(out).toMatch(/CREDIT_CARD_NUMBER/);
    expect(out).toMatch(/PII/);
    sh.dispose();
  });

  it('DBA_TSDP_POLICY shows one policy per active classification', () => {
    const sh = newSession('sec-tsdp-3');
    const out = run(sh, `SELECT POLICY_NAME, STATUS FROM DBA_TSDP_POLICY;`);
    expect(out).toMatch(/ORA_SIM_PII/);
    expect(out).toMatch(/ENABLED/);
    sh.dispose();
  });

  it('DBA_TSDP_POLICY_FEATURE attaches FGA to every simulated policy', () => {
    const sh = newSession('sec-tsdp-4');
    const out = run(sh, `SELECT POLICY_NAME, FEATURE_NAME FROM DBA_TSDP_POLICY_FEATURE;`);
    expect(out).toMatch(/FGA/);
    sh.dispose();
  });
});

describe('security audit — Database Vault (SoD)', () => {
  it('DBA_DV_RULE_SET ships canonical SoD rule sets', () => {
    const sh = newSession('sec-sod-1');
    const out = run(sh, `SELECT RULE_SET_NAME FROM DBA_DV_RULE_SET;`);
    expect(out).toMatch(/SOD_DBA_AUDITOR/);
    expect(out).toMatch(/SOD_DATA_EXFILTRATION/);
    sh.dispose();
  });

  it('DBA_DV_RULE shows the SoD predicates', () => {
    const sh = newSession('sec-sod-2');
    const out = run(sh, `SELECT NAME, ENABLED FROM DBA_DV_RULE;`);
    expect(out).toMatch(/SOD_DBA_AUDITOR/);
    sh.dispose();
  });

  it('a SoD breach surfaces in UNIFIED_AUDIT_TRAIL as AUDIT_TYPE=DatabaseVault', () => {
    const sh = newSession('sec-sod-3');
    sh.processLine('GRANT SELECT ANY TABLE TO SCOTT;');
    sh.processLine('GRANT CREATE ANY DIRECTORY TO SCOTT;');
    const out = run(sh,
      `SELECT DBUSERNAME, AUDIT_TYPE, SYSTEM_PRIVILEGE_USED FROM UNIFIED_AUDIT_TRAIL WHERE AUDIT_TYPE='DatabaseVault';`);
    expect(out).toMatch(/SCOTT/);
    expect(out).toMatch(/SOD_DATA_EXFILTRATION/);
    sh.dispose();
  });
});

describe('security audit — anomalies surface in native alert views', () => {
  it('SECDEMO RUN produces anomalies visible in DBA_OUTSTANDING_ALERTS', () => {
    const sh = newSession('sec-anom-1');
    const demo = run(sh, 'SECDEMO RUN;');
    expect(demo).toMatch(/BRUTE_FORCE/);
    const alerts = run(sh, `SELECT REASON_ID, MESSAGE FROM DBA_OUTSTANDING_ALERTS WHERE OBJECT_TYPE='Security';`);
    expect(alerts).toMatch(/PRIVILEGE_ESCALATION|SOD_BREACH|SENSITIVE_OBJECT_EXPORT|BRUTE_FORCE_ATTEMPT/);
    sh.dispose();
  });

  it('DBA_ALERT_HISTORY captures every anomaly with creation/resolution time', () => {
    const sh = newSession('sec-anom-2');
    run(sh, 'SECDEMO RUN;');
    const out = run(sh, `SELECT REASON_ID, SEVERITY, CREATION_TIME FROM DBA_ALERT_HISTORY;`);
    expect(out).toMatch(/CRITICAL|HIGH/);
  });
});

describe('security audit — SECDEMO control surface', () => {
  it('SECDEMO STATUS reports non-zero journal sizes after activity', () => {
    const sh = newSession('sec-demo-1');
    sh.processLine('CREATE TABLE TX (id NUMBER);');
    const out = run(sh, 'SECDEMO STATUS;');
    expect(out).toMatch(/Connection traces:/);
    expect(out).toMatch(/DDL history:\s*[1-9]/);
    expect(out).toMatch(/SoD policies:\s*[1-9]/);
    sh.dispose();
  });

  it('SECDEMO SCAN DORMANT runs the dormant analyzer', () => {
    const sh = newSession('sec-demo-2');
    const out = run(sh, 'SECDEMO SCAN DORMANT;');
    expect(out).toMatch(/Dormant-account sweep complete/);
    sh.dispose();
  });

  it('SECDEMO SCAN SOD runs the SoD evaluator', () => {
    const sh = newSession('sec-demo-3');
    const out = run(sh, 'SECDEMO SCAN SOD;');
    expect(out).toMatch(/SoD scan complete/);
    sh.dispose();
  });
});

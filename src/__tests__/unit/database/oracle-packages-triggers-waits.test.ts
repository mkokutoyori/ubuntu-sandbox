/**
 * SQL-driven tests for the third reactive slice:
 *   - DBMS_APPLICATION_INFO.SET_MODULE / SET_ACTION / SET_CLIENT_INFO
 *   - DBMS_SESSION.SET_IDENTIFIER / SET_CONTEXT / CLEAR_CONTEXT
 *   - System-level event triggers (AFTER LOGON / BEFORE LOGOFF / …)
 *   - Wait events: V$SESSION_EVENT / V$SYSTEM_EVENT / V$EVENT_HISTOGRAM
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

function newSession(name: string): SqlPlusSubShell {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}

function run(sh: SqlPlusSubShell, sql: string): string {
  return sh.processLine(sql).output.join('\n');
}

describe('DBMS_APPLICATION_INFO', () => {
  it('SET_MODULE updates V$SESSION.MODULE and V$SESSION_CONTEXT', () => {
    const sh = newSession('dai-1');
    sh.processLine("BEGIN DBMS_APPLICATION_INFO.SET_MODULE('billing', 'invoice-run'); END;");
    const sess = run(sh, "SELECT MODULE, ACTION FROM V$SESSION WHERE TYPE='USER' AND USERNAME='SYS';");
    expect(sess).toMatch(/billing/);
    expect(sess).toMatch(/invoice-run/);
    const ctx = run(sh, "SELECT ATTRIBUTE, VALUE FROM V$SESSION_CONTEXT WHERE ATTRIBUTE IN ('MODULE','ACTION');");
    expect(ctx).toMatch(/MODULE\s+billing/);
    expect(ctx).toMatch(/ACTION\s+invoice-run/);
    sh.dispose();
  });

  it('SET_ACTION updates only ACTION', () => {
    const sh = newSession('dai-2');
    sh.processLine("BEGIN DBMS_APPLICATION_INFO.SET_MODULE('m', 'a1'); END;");
    sh.processLine("BEGIN DBMS_APPLICATION_INFO.SET_ACTION('a2'); END;");
    const out = run(sh, "SELECT MODULE, ACTION FROM V$SESSION WHERE TYPE='USER';");
    expect(out).toMatch(/m\s+a2/);
    sh.dispose();
  });

  it('SET_CLIENT_INFO updates V$SESSION.CLIENT_INFO', () => {
    const sh = newSession('dai-3');
    sh.processLine("BEGIN DBMS_APPLICATION_INFO.SET_CLIENT_INFO('mobile-app v1.2'); END;");
    const out = run(sh, "SELECT CLIENT_INFO FROM V$SESSION WHERE TYPE='USER';");
    expect(out).toMatch(/mobile-app v1\.2/);
    sh.dispose();
  });
});

describe('DBMS_SESSION', () => {
  it('SET_IDENTIFIER populates V$SESSION.CLIENT_IDENTIFIER', () => {
    const sh = newSession('ds-1');
    sh.processLine("BEGIN DBMS_SESSION.SET_IDENTIFIER('order-7281'); END;");
    const out = run(sh, "SELECT CLIENT_IDENTIFIER FROM V$SESSION WHERE TYPE='USER';");
    expect(out).toMatch(/order-7281/);
    sh.dispose();
  });

  it('CLEAR_IDENTIFIER blanks the value', () => {
    const sh = newSession('ds-2');
    sh.processLine("BEGIN DBMS_SESSION.SET_IDENTIFIER('xyz'); END;");
    sh.processLine("BEGIN DBMS_SESSION.CLEAR_IDENTIFIER; END;");
    const out = run(sh, "SELECT CLIENT_IDENTIFIER FROM V$SESSION WHERE TYPE='USER';");
    expect(out).not.toMatch(/xyz/);
    sh.dispose();
  });

  it('SET_CONTEXT registers a user-defined context that surfaces in V$SESSION_CONTEXT', () => {
    const sh = newSession('ds-3');
    sh.processLine("BEGIN DBMS_SESSION.SET_CONTEXT('APP_CTX', 'TENANT_ID', 'TENANT_42'); END;");
    const out = run(sh, "SELECT NAMESPACE, ATTRIBUTE, VALUE FROM V$SESSION_CONTEXT WHERE NAMESPACE='APP_CTX';");
    expect(out).toMatch(/APP_CTX\s+TENANT_ID\s+TENANT_42/);
    sh.dispose();
  });

  it('CLEAR_CONTEXT removes the entry', () => {
    const sh = newSession('ds-4');
    sh.processLine("BEGIN DBMS_SESSION.SET_CONTEXT('APP_CTX', 'TENANT_ID', 'T42'); END;");
    sh.processLine("BEGIN DBMS_SESSION.CLEAR_CONTEXT('APP_CTX', 'TENANT_ID'); END;");
    const out = run(sh, "SELECT VALUE FROM V$SESSION_CONTEXT WHERE NAMESPACE='APP_CTX' AND ATTRIBUTE='TENANT_ID';");
    expect(out).not.toMatch(/T42/);
    sh.dispose();
  });
});

describe('System-level event triggers', () => {
  it('CREATE TRIGGER … AFTER LOGON ON DATABASE registers in DBA_TRIGGERS', () => {
    const sh = newSession('st-1');
    sh.processLine("CREATE TRIGGER LOG_LOGON AFTER LOGON ON DATABASE BEGIN NULL; END;");
    const out = run(sh, "SELECT TRIGGER_NAME, TRIGGERING_EVENT, STATUS FROM DBA_TRIGGERS WHERE TRIGGER_NAME='LOG_LOGON';");
    expect(out).toMatch(/LOG_LOGON/);
    expect(out).toMatch(/LOGON/);
    expect(out).toMatch(/ENABLED/);
    sh.dispose();
  });

  it('CREATE TRIGGER … BEFORE LOGOFF ON DATABASE fires on disconnect', () => {
    const sh = newSession('st-2');
    sh.processLine("CREATE TRIGGER LOG_LOGOFF BEFORE LOGOFF ON DATABASE BEGIN NULL; END;");
    sh.processLine("CONNECT HR/hr;");
    sh.processLine("DISCONNECT;");
    sh.processLine("CONNECT / AS SYSDBA;");
    // The alert log must mention the trigger firing.
    const out = run(sh, "SELECT MESSAGE FROM DBA_ALERT_HISTORY WHERE MESSAGE LIKE '%LOG_LOGOFF%';");
    expect(out).toMatch(/LOG_LOGOFF/);
    sh.dispose();
  });
});

describe('Wait events', () => {
  it('SQL execution populates V$SESSION_EVENT', () => {
    const sh = newSession('we-1');
    sh.processLine("CREATE TABLE W_TAB (id NUMBER);");
    sh.processLine("INSERT INTO W_TAB VALUES (1);");
    sh.processLine("COMMIT;");
    const out = run(sh, "SELECT EVENT, WAIT_CLASS FROM V$SESSION_EVENT;");
    expect(out).toMatch(/SQL\*Net message from client|SQL\*Net message to client|db file sequential read|log file sync/);
    sh.dispose();
  });

  it('COMMIT triggers a log file sync wait', () => {
    const sh = newSession('we-2');
    sh.processLine("CREATE TABLE W_TAB2 (id NUMBER);");
    sh.processLine("INSERT INTO W_TAB2 VALUES (1);");
    sh.processLine("COMMIT;");
    const out = run(sh, "SELECT EVENT, TOTAL_WAITS FROM V$SYSTEM_EVENT WHERE EVENT='log file sync';");
    expect(out).toMatch(/log file sync/);
    sh.dispose();
  });

  it('V$EVENT_HISTOGRAM contains a row per (event, log bucket)', () => {
    const sh = newSession('we-3');
    sh.processLine("CREATE TABLE W_TAB3 (id NUMBER);");
    sh.processLine("INSERT INTO W_TAB3 VALUES (1);");
    sh.processLine("COMMIT;");
    const out = run(sh, "SELECT EVENT, WAIT_TIME_MILLI, WAIT_COUNT FROM V$EVENT_HISTOGRAM WHERE EVENT='log file sync';");
    expect(out).toMatch(/log file sync/);
    sh.dispose();
  });
});

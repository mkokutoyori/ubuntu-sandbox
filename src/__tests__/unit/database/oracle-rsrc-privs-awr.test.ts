/**
 * SQL-driven tests for the fourth reactive slice:
 *   - Resource Manager (real ResourceManager class + reactive switcher)
 *     · DBA_RSRC_PLANS / DBA_RSRC_CONSUMER_GROUPS / DBA_RSRC_PLAN_DIRECTIVES
 *     · DBMS_RESOURCE_MANAGER package routines
 *   - Privilege views coherent with effective grants:
 *     · USER_TAB_PRIVS_MADE / USER_TAB_PRIVS_RECD
 *     · ALL_TAB_PRIVS_MADE / ALL_TAB_PRIVS_RECD
 *   - AWR snapshots:
 *     · DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT
 *     · DBA_HIST_SNAPSHOT / DBA_HIST_SYSSTAT
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

describe('Resource Manager — seeded catalogue', () => {
  it('DBA_RSRC_PLANS lists the system-supplied plans', () => {
    const sh = newSession('rm-1');
    const out = run(sh, 'SELECT PLAN FROM DBA_RSRC_PLANS;');
    expect(out).toMatch(/DEFAULT_PLAN/);
    expect(out).toMatch(/DEFAULT_MAINTENANCE_PLAN/);
    expect(out).toMatch(/INTERNAL_PLAN/);
    sh.dispose();
  });

  it('DBA_RSRC_CONSUMER_GROUPS lists SYS_GROUP / OTHER_GROUPS', () => {
    const sh = newSession('rm-2');
    const out = run(sh, 'SELECT CONSUMER_GROUP, MANDATORY FROM DBA_RSRC_CONSUMER_GROUPS;');
    expect(out).toMatch(/SYS_GROUP\s+YES/);
    expect(out).toMatch(/OTHER_GROUPS\s+YES/);
    expect(out).toMatch(/DEFAULT_CONSUMER_GROUP/);
    sh.dispose();
  });

  it('DBA_RSRC_PLAN_DIRECTIVES surfaces SWITCH_TIME / SWITCH_GROUP', () => {
    const sh = newSession('rm-3');
    const out = run(sh, "SELECT GROUP_OR_SUBPLAN, SWITCH_TIME, SWITCH_GROUP FROM DBA_RSRC_PLAN_DIRECTIVES WHERE PLAN='DEFAULT_PLAN';");
    expect(out).toMatch(/LOW_GROUP/);
    expect(out).toMatch(/OTHER_GROUPS/);
    sh.dispose();
  });

  it('DBA_RSRC_GROUP_MAPPINGS maps SYS to SYS_GROUP', () => {
    const sh = newSession('rm-4');
    const out = run(sh, "SELECT ATTRIBUTE, VALUE, CONSUMER_GROUP FROM DBA_RSRC_GROUP_MAPPINGS WHERE VALUE='SYS';");
    expect(out).toMatch(/ORACLE_USER\s+SYS\s+SYS_GROUP/);
    sh.dispose();
  });
});

describe('DBMS_RESOURCE_MANAGER', () => {
  it('CREATE_CONSUMER_GROUP adds a row to DBA_RSRC_CONSUMER_GROUPS', () => {
    const sh = newSession('rm-5');
    sh.processLine("BEGIN DBMS_RESOURCE_MANAGER.CREATE_CONSUMER_GROUP('REPORTING_GRP', 'Reporting users'); END;");
    const out = run(sh, "SELECT CONSUMER_GROUP FROM DBA_RSRC_CONSUMER_GROUPS WHERE CONSUMER_GROUP='REPORTING_GRP';");
    expect(out).toMatch(/REPORTING_GRP/);
    sh.dispose();
  });

  it('CREATE_PLAN + CREATE_PLAN_DIRECTIVE wire a new plan correctly', () => {
    const sh = newSession('rm-6');
    sh.processLine("BEGIN DBMS_RESOURCE_MANAGER.CREATE_PLAN('NIGHT_BATCH_PLAN', 'Night batch window'); END;");
    sh.processLine("BEGIN DBMS_RESOURCE_MANAGER.CREATE_PLAN_DIRECTIVE('NIGHT_BATCH_PLAN', 'BATCH_GROUP', 'Batch tier', 80); END;");
    const plans = run(sh, "SELECT PLAN FROM DBA_RSRC_PLANS WHERE PLAN='NIGHT_BATCH_PLAN';");
    expect(plans).toMatch(/NIGHT_BATCH_PLAN/);
    const dirs = run(sh, "SELECT GROUP_OR_SUBPLAN, MGMT_P1 FROM DBA_RSRC_PLAN_DIRECTIVES WHERE PLAN='NIGHT_BATCH_PLAN';");
    expect(dirs).toMatch(/BATCH_GROUP/);
    expect(dirs).toMatch(/\s80/);
    sh.dispose();
  });
});

describe('Privilege views — MADE / RECD', () => {
  it('USER_TAB_PRIVS_MADE lists grants the connected user issued', () => {
    const sh = newSession('priv-1');
    sh.processLine('CREATE TABLE PV_TBL (id NUMBER);');
    sh.processLine('GRANT SELECT ON PV_TBL TO HR;');
    const out = run(sh, "SELECT GRANTEE, TABLE_NAME, PRIVILEGE FROM USER_TAB_PRIVS_MADE WHERE TABLE_NAME='PV_TBL';");
    expect(out).toMatch(/HR\s+PV_TBL\s+SELECT/);
    sh.dispose();
  });

  it('USER_TAB_PRIVS_RECD shows received grants after reconnecting as the grantee', () => {
    const sh = newSession('priv-2');
    sh.processLine('CREATE TABLE RECD_TBL (id NUMBER);');
    sh.processLine('GRANT SELECT ON RECD_TBL TO HR;');
    sh.processLine('CONNECT HR/hr;');
    const out = run(sh, "SELECT OWNER, TABLE_NAME, PRIVILEGE FROM USER_TAB_PRIVS_RECD WHERE TABLE_NAME='RECD_TBL';");
    expect(out).toMatch(/SYS\s+RECD_TBL\s+SELECT/);
    sh.dispose();
  });

  it('ALL_TAB_PRIVS_RECD includes role-derived grants', () => {
    const sh = newSession('priv-3');
    sh.processLine('CREATE TABLE ROLE_T (id NUMBER);');
    sh.processLine('CREATE ROLE READER;');
    sh.processLine('GRANT SELECT ON ROLE_T TO READER;');
    sh.processLine('GRANT READER TO HR;');
    sh.processLine('CONNECT HR/hr;');
    const out = run(sh, "SELECT GRANTEE, TABLE_NAME, PRIVILEGE, INHERITED FROM ALL_TAB_PRIVS_RECD WHERE TABLE_NAME='ROLE_T';");
    expect(out).toMatch(/READER\s+ROLE_T\s+SELECT\s+YES/);
    sh.dispose();
  });
});

describe('AWR snapshots — DBMS_WORKLOAD_REPOSITORY', () => {
  it('CREATE_SNAPSHOT adds a row to DBA_HIST_SNAPSHOT with SOURCE=MANUAL', () => {
    const sh = newSession('awr-1');
    sh.processLine("BEGIN DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT; END;");
    const out = run(sh, "SELECT SNAP_ID, SOURCE FROM DBA_HIST_SNAPSHOT WHERE SOURCE='MANUAL';");
    expect(out).toMatch(/MANUAL/);
    expect(out).toMatch(/1/);
    sh.dispose();
  });

  it('snapshot captures SYS stats visible in DBA_HIST_SYSSTAT', () => {
    const sh = newSession('awr-2');
    sh.processLine('CREATE TABLE AWR_T (id NUMBER);');
    sh.processLine('INSERT INTO AWR_T VALUES (1);');
    sh.processLine('COMMIT;');
    sh.processLine("BEGIN DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT; END;");
    const out = run(sh, "SELECT STAT_NAME, VALUE FROM DBA_HIST_SYSSTAT WHERE STAT_NAME='user commits';");
    expect(out).toMatch(/user commits/);
    // After the COMMIT we expect a positive value.
    expect(out).toMatch(/\s[1-9]/);
    sh.dispose();
  });

  it('DROP_SNAPSHOT_RANGE removes snapshots in the given window', () => {
    const sh = newSession('awr-3');
    sh.processLine("BEGIN DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT; END;");
    sh.processLine("BEGIN DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT; END;");
    sh.processLine("BEGIN DBMS_WORKLOAD_REPOSITORY.DROP_SNAPSHOT_RANGE(1, 1); END;");
    const out = run(sh, "SELECT SNAP_ID FROM DBA_HIST_SNAPSHOT WHERE SOURCE='MANUAL';");
    // After dropping snap_id=1 only snap_id=2 should remain.
    expect(out).toMatch(/^2\s*$/m);
    expect(out).toMatch(/1 row selected/);
    sh.dispose();
  });
});

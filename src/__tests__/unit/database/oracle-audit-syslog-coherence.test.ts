/**
 * AUDIT_SYSLOG_LEVEL coherence — when the parameter is set, Oracle audit
 * records are forwarded to the host syslog (/var/log/syslog) at the
 * configured facility.priority, exactly like a real database wired to
 * rsyslog. When the parameter is unset (the default), nothing is written
 * to syslog — the audit stays in the trail / adump only.
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

const syslog = (sh: SqlPlusSubShell): string =>
  sh.processLine('HOST cat /var/log/syslog').output.join('\n');

describe('AUDIT_SYSLOG_LEVEL → host syslog', () => {
  it('forwards an audited DDL to /var/log/syslog when the level is set', () => {
    const srv = new LinuxServer('linux-server', 'ora-syslog', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);

    subShell.processLine("ALTER SYSTEM SET audit_syslog_level = 'local0.info';");
    subShell.processLine("CREATE TABLESPACE sl_data DATAFILE '/u01/oradata/ORCL/sl_data01.dbf' SIZE 10M;");

    const log = syslog(subShell);
    expect(log).toMatch(/Oracle Audit/);
    expect(log).toMatch(/CREATE TABLESPACE/);
    subShell.dispose();
  });

  it('writes nothing to syslog when AUDIT_SYSLOG_LEVEL is unset (default)', () => {
    const srv = new LinuxServer('linux-server', 'ora-nosyslog', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);

    subShell.processLine("CREATE TABLESPACE ns_data DATAFILE '/u01/oradata/ORCL/ns_data01.dbf' SIZE 10M;");

    expect(syslog(subShell)).not.toMatch(/Oracle Audit/);
    subShell.dispose();
  });

  it('the forwarded line carries the database user and action', () => {
    const srv = new LinuxServer('linux-server', 'ora-syslog-fields', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);

    subShell.processLine("ALTER SYSTEM SET audit_syslog_level = 'local0.info';");
    subShell.processLine("CREATE TABLESPACE fld_data DATAFILE '/u01/oradata/ORCL/fld01.dbf' SIZE 10M;");

    const oracleAuditLines = syslog(subShell)
      .split('\n')
      .filter(l => /Oracle Audit/.test(l) && /CREATE TABLESPACE/.test(l));
    expect(oracleAuditLines.length).toBeGreaterThan(0);
    expect(oracleAuditLines.join('\n')).toMatch(/DBUSERID:\[\d+\] "SYS"/);
    subShell.dispose();
  });
});

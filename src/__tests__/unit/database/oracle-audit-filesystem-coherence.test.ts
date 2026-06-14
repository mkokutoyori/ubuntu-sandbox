/**
 * audit_file_dest coherence — when SYS performs audited operations,
 * Oracle writes one .aud file per session under adump/. Before this
 * change the directory existed but stayed empty even after many
 * audited statements.
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

describe('audit_file_dest', () => {
  it('writes a .aud file under adump/ when SYS performs an audited DDL', () => {
    const srv = new LinuxServer('linux-server', 'ora-audit', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    subShell.processLine("CREATE TABLESPACE app_data DATAFILE '/u01/oradata/ORCL/app_data01.dbf' SIZE 100M;");

    const out = subShell.processLine(`HOST ls ${ORACLE_CONFIG.AUDIT_DIR}`).output.join('\n');
    expect(out).toMatch(/\.aud/);
    subShell.dispose();
  });

  it('audit file contains the SQL text of the audited statement', () => {
    const srv = new LinuxServer('linux-server', 'ora-audit-content', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    subShell.processLine("CREATE TABLESPACE marker_ts DATAFILE '/u01/oradata/ORCL/marker.dbf' SIZE 10M;");

    // `ls` order is not specified — pick the most recently-created file
    // by grepping all of them for the marker SQL text.
    const lsOut = subShell.processLine(`HOST ls ${ORACLE_CONFIG.AUDIT_DIR}`).output.join('\n');
    const audNames = lsOut.split(/\s+/).filter(n => n.endsWith('.aud'));
    const contents = audNames.map(n =>
      subShell.processLine(`HOST cat ${ORACLE_CONFIG.AUDIT_DIR}/${n}`).output.join('\n')
    );
    const match = contents.find(c => /CREATE TABLESPACE marker_ts/i.test(c));
    expect(match, `no .aud file mentions CREATE TABLESPACE marker_ts; files: ${audNames.join(', ')}`).toBeDefined();
    expect(match!).toMatch(/ACTION\s*:\s*CREATE TABLESPACE/i);
    subShell.dispose();
  });
});

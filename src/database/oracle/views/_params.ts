/**
 * Shared parameter metadata for V$PARAMETER / V$SPPARAMETER views.
 *
 * `PARAMETER_DESCRIPTIONS` feeds the DESCRIPTION column; `paramType`
 * maps a value to Oracle's numeric TYPE code. Kept next to the views
 * that use it so each view file is self-contained.
 */

/** Parameter descriptions for V$PARAMETER.DESCRIPTION column. */
export const PARAMETER_DESCRIPTIONS: Record<string, string> = {
  db_name: 'Database name specified in CREATE DATABASE',
  db_domain: 'Directory path prefix for global database name',
  db_unique_name: 'Unique database name',
  db_block_size: 'Size of database block in bytes',
  db_cache_size: 'Size of DEFAULT buffer pool for standard blocks',
  shared_pool_size: 'Size of shared pool in bytes',
  sga_target: 'Target size of SGA',
  sga_max_size: 'Maximum size of SGA for the instance',
  pga_aggregate_target: 'Target size for aggregate PGA memory',
  memory_target: 'Target memory size (SGA+PGA)',
  memory_max_target: 'Maximum memory size for auto memory management',
  processes: 'Max number of user processes',
  sessions: 'Max number of sessions',
  open_cursors: 'Max number of open cursors per session',
  undo_management: 'Instance runs in SMU or Auto Undo mode',
  undo_tablespace: 'Undo tablespace name for auto undo management',
  undo_retention: 'Undo retention in seconds',
  compatible: 'Database will be completely compatible with this release',
  audit_trail: 'Enable system auditing',
  audit_file_dest: 'Directory for audit trail files',
  diagnostic_dest: 'Diagnostic base directory',
  control_files: 'Control file name list',
  log_archive_dest_1: 'Primary archive log destination',
  log_archive_format: 'Archive log file name format',
  db_recovery_file_dest: 'Default database recovery file destination',
  db_recovery_file_dest_size: 'Database recovery file dest size',
  remote_login_passwordfile: 'Password file usage parameter',
  instance_name: 'Instance name for Oracle instance',
  service_names: 'Service names this instance supports',
  nls_language: 'NLS language name',
  nls_territory: 'NLS territory name',
  nls_date_format: 'NLS default date format',
  nls_characterset: 'Database character set',
  optimizer_mode: 'Optimizer mode',
  cursor_sharing: 'Cursor sharing mode',
  recyclebin: 'Enable or disable the recyclebin',
  local_listener: 'Local listener address',
  dispatchers: 'Specifications of dispatchers',
  parallel_max_servers: 'Max number of parallel execution servers',
  parallel_min_servers: 'Min number of parallel execution servers',
  archive_log_mode: 'Archive log mode',
  java_pool_size: 'Size of Java pool in bytes',
  large_pool_size: 'Size of large pool in bytes',
  db_files: 'Max allowable number of database files',
  resource_limit: 'Master switch for resource limit enforcement',
  sec_case_sensitive_logon: 'Case sensitive logon enabled',
};

/** Oracle V$PARAMETER TYPE: 1=Boolean, 2=String, 3=Integer, 6=Big integer. */
export function paramType(value: string): number {
  if (value === 'TRUE' || value === 'FALSE') return 1;
  if (/^\d+$/.test(value)) return 3;
  if (/^\d+[MmGgKk]$/.test(value)) return 6;
  return 2;
}

import type { ResultSet } from '../../engine/executor/ResultSet';
import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import type { OracleInstance } from '../OracleInstance';

/** Shared row builder for V$PARAMETER / V$SYSTEM_PARAMETER. */
export function buildVParameter(instance: OracleInstance): ResultSet {
  const params = instance.getAllParameters();
  return queryResult(
    [
      { name: 'NUM', dataType: { name: 'NUMBER', nullable: true } },
      { name: 'NAME', dataType: oracleVarchar2(80) },
      { name: 'TYPE', dataType: { name: 'NUMBER', nullable: true } },
      { name: 'VALUE', dataType: oracleVarchar2(512) },
      { name: 'DISPLAY_VALUE', dataType: oracleVarchar2(512) },
      { name: 'ISDEFAULT', dataType: oracleVarchar2(9) },
      { name: 'ISMODIFIED', dataType: oracleVarchar2(10) },
      { name: 'DESCRIPTION', dataType: oracleVarchar2(255) },
    ],
    Array.from(params.entries()).map(([name, value], idx) => {
      const type = paramType(value);
      const isDefault = instance.isParameterModified(name) ? 'FALSE' : 'TRUE';
      const isModified = instance.isParameterModified(name) ? 'MODIFIED' : 'FALSE';
      const desc = PARAMETER_DESCRIPTIONS[name] ?? '';
      return [idx + 1, name, type, value, value, isDefault, isModified, desc];
    })
  );
}

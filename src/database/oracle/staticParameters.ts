const STATIC_PARAMETERS: ReadonlySet<string> = new Set([
  'audit_trail',
  'audit_sys_operations',
  'sessions',
  'processes',
  'transactions',
  'db_block_size',
  'db_name',
  'db_files',
  'compatible',
  'undo_management',
  'log_buffer',
  'enable_pluggable_database',
  'remote_login_passwordfile',
  'db_writer_processes',
]);

export function isStaticParameter(name: string): boolean {
  return STATIC_PARAMETERS.has(name.trim().toLowerCase());
}

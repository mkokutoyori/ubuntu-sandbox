/**
 * RmanError — discriminated union of every typed error that can flow
 * out of the RMAN module via Result<_, RmanError>.
 *
 * Codes are aligned with Oracle's RMAN-NNNNN where applicable; internal
 * categories (CATALOG_*, CHANNEL_*, VFS_*, JOB_*, POLICY_*) use named
 * codes to keep matching trivial in tests and adapters.
 */

export type RmanError =
  // Connection / parsing
  | { code: 'RMAN_00558'; message: string }   // syntax error
  | { code: 'RMAN_01009'; message: string }   // unknown command
  | { code: 'RMAN_03002'; message: string }   // target db not connected
  | { code: 'RMAN_06004'; message: string }   // backup piece not found
  | { code: 'RMAN_06023'; message: string }   // no backup found to restore
  | { code: 'RMAN_06403'; message: string }   // database must be mounted (not open)
  | { code: 'RMAN_04014'; message: string }   // oracle instance is not started
  // Catalog
  | { code: 'CATALOG_READ_ERROR';   message: string }
  | { code: 'CATALOG_WRITE_ERROR';  message: string }
  | { code: 'BACKUP_KEY_NOT_FOUND'; message: string; key: string }
  | { code: 'SCN_INVALID';          message: string; raw: string }
  // Channel
  | { code: 'NO_CHANNEL_AVAILABLE'; message: string }
  | { code: 'CHANNEL_TIMEOUT';      message: string; channelId: string }
  | { code: 'CHANNEL_IO_ERROR';     message: string; channelId: string }
  // VFS
  | { code: 'VFS_WRITE_ERROR';      message: string; path: string }
  | { code: 'VFS_READ_ERROR';       message: string; path: string }
  | { code: 'VFS_NO_SPACE';         message: string; available: number }
  // Job
  | { code: 'JOB_CANCELLED';        message: string; jobId: string }
  | { code: 'JOB_TIMEOUT';          message: string; jobId: string }
  // Policy
  | { code: 'RETENTION_EVAL_ERROR'; message: string };

/** Map every error code to the Oracle-canonical "RMAN-NNNNN" prefix
 *  the real RMAN client emits. Internal sandbox categories
 *  (CATALOG_*, VFS_*, CHANNEL_*, JOB_*, POLICY_*) are normalised onto
 *  the closest Oracle code so transcripts paste cleanly against real
 *  Oracle docs / KB articles. */
const ORACLE_CODE_MAP: Record<string, string> = {
  // Catalog
  CATALOG_READ_ERROR:    'RMAN-06026',  // unable to find datafile from catalog
  CATALOG_WRITE_ERROR:   'RMAN-06091',  // no channel allocated for catalog op
  BACKUP_KEY_NOT_FOUND:  'RMAN-06024',  // no backup or copy of <…> found
  SCN_INVALID:           'RMAN-06026',
  // Channel
  NO_CHANNEL_AVAILABLE:  'RMAN-06403',  // (re-using existing 06403 for "no channel")
  CHANNEL_TIMEOUT:       'RMAN-03009',
  CHANNEL_IO_ERROR:      'RMAN-03002',
  // VFS
  VFS_WRITE_ERROR:       'RMAN-19625',  // (similar to ORA-19625)
  VFS_READ_ERROR:        'RMAN-19625',
  VFS_NO_SPACE:          'RMAN-19811',  // out of space in the FRA
  // Job
  JOB_CANCELLED:         'RMAN-03014',
  JOB_TIMEOUT:           'RMAN-03009',
  // Policy
  RETENTION_EVAL_ERROR:  'RMAN-08137',
};

export function rmanErrorMessage(e: RmanError): string {
  // Oracle prints "RMAN-NNNNN" (hyphen). Our discriminant union uses
  // underscores so TypeScript can narrow; rewrite to hyphens for any
  // RMAN_NNNNN code, fall back to the ORACLE_CODE_MAP for internal
  // categories so the transcript stays Oracle-shaped.
  const code = /^RMAN_\d+$/.test(e.code)
    ? e.code.replace('_', '-')
    : (ORACLE_CODE_MAP[e.code] ?? e.code);
  return `${code}: ${e.message}`;
}

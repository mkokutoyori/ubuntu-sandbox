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

export function rmanErrorMessage(e: RmanError): string {
  // Oracle prints "RMAN-NNNNN" (hyphen). Our discriminant union uses
  // underscores so TypeScript can narrow; rewrite to hyphens for any
  // RMAN_NNNNN code, keep internal categories (CATALOG_*, VFS_*, …)
  // as-is.
  const code = /^RMAN_\d+$/.test(e.code) ? e.code.replace('_', '-') : e.code;
  return `${code}: ${e.message}`;
}

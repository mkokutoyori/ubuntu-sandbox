/**
 * SftpStatusCodes — real `SSH_FX_*` numeric status table (draft-ietf-
 * secsh-filexfer §7/§9.1, PRD-FTP-SFTP.md §2.1.15/P15) plus the single
 * correspondence table from the existing `Result`/`SshError` layer to
 * it, so every SFTP reply site shares one mapping instead of each
 * bridge re-deriving its own.
 */
import type { SshError } from '../Result';

export const SSH_FX = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
} as const;

export type SftpStatusCode = (typeof SSH_FX)[keyof typeof SSH_FX];

export interface SftpStatus {
  readonly code: SftpStatusCode;
  readonly message: string;
}

export function okStatus(): SftpStatus {
  return { code: SSH_FX.OK, message: 'OK' };
}

/** Translates an `SshError` from the existing `ISftpFileSystem`/dispatcher layer to its `SSH_FX_*` status. */
export function statusFromError(error: SshError): SftpStatus {
  switch (error.kind) {
    case 'PERMISSION_DENIED':
      return { code: SSH_FX.PERMISSION_DENIED, message: 'Permission denied.' };
    case 'UNKNOWN_OP':
      return { code: SSH_FX.OP_UNSUPPORTED, message: `Unsupported operation: ${error.op}` };
    case 'IO_ERROR':
      return {
        code: /no such|not found/i.test(error.message) ? SSH_FX.NO_SUCH_FILE : SSH_FX.FAILURE,
        message: error.message,
      };
    case 'INVALID_ARGUMENT':
      return { code: SSH_FX.BAD_MESSAGE, message: error.message };
    default:
      return { code: SSH_FX.FAILURE, message: 'Failure.' };
  }
}

import type { OracleRuntimeState } from '../views/OracleRuntimeState';
import { parseSize } from '../views/_fileSize';

export interface RecoveryAreaUsage {
  readonly destination:       string;
  readonly limitBytes:        number;
  readonly usedBytes:         number;
  readonly backupPieceBytes:  number;
  readonly backupPieceCount:  number;
  readonly archivedLogBytes:  number;
  readonly archivedLogCount:  number;
  readonly flashbackLogCount: number;
  readonly fileCount:         number;
}

export const ARCHIVED_LOG_BYTES = 1_048_576;

export function isInsideRecoveryArea(path: string, destination: string): boolean {
  if (!destination) return false;
  const root = destination.replace(/\/+$/, '');
  return path === root || path.startsWith(`${root}/`);
}

export function recoveryAreaUsage(
  destination: string,
  limitText: string | undefined,
  runtime: Pick<OracleRuntimeState, 'backups' | 'archivedLogs' | 'flashbackHistory'>,
): RecoveryAreaUsage {
  const pieces = runtime.backups.filter(b => isInsideRecoveryArea(b.handle, destination));
  const logs = runtime.archivedLogs.filter(l => isInsideRecoveryArea(l.name, destination));
  const backupPieceBytes = pieces.reduce((total, b) => total + b.bytes, 0);
  const archivedLogBytes = logs.length * ARCHIVED_LOG_BYTES;
  return {
    destination,
    limitBytes:        parseSize(limitText ?? '4G'),
    usedBytes:         backupPieceBytes + archivedLogBytes,
    backupPieceBytes,
    backupPieceCount:  pieces.length,
    archivedLogBytes,
    archivedLogCount:  logs.length,
    flashbackLogCount: runtime.flashbackHistory.length,
    fileCount:         pieces.length + logs.length,
  };
}

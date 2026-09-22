import type {
  IRmanOracleContext, VfsAdapter, DatafileInfo, ConnectTargetOutcome, ConnectPeerOutcome, RecordedBackupPiece,
  SqlStatementOutcome, RmanCredentials, ArchivedLogRecord, BlockCorruptionType,
} from './IRmanOracleContext';
import type { DbId } from '../values/DbId';
import type { Equipment } from '@/network';
import { LinuxRmanContext } from './LinuxRmanContext';

export class RetargetableRmanContext implements IRmanOracleContext {
  private _current: LinuxRmanContext;

  constructor(
    private readonly _localDevice: Equipment,
    initial: LinuxRmanContext,
    private readonly _onRetarget?: (deviceId: string) => void,
  ) {
    this._current = initial;
  }

  get dbId(): DbId { return this._current.dbId; }
  get dbName(): string { return this._current.dbName; }
  get vfs(): VfsAdapter { return this._current.vfs; }

  getDatafiles(): ReadonlyArray<DatafileInfo> { return this._current.getDatafiles(); }
  getSpfileParam(name: string): string | undefined { return this._current.getSpfileParam(name); }
  getArchivelogPaths(): ReadonlyArray<string> { return this._current.getArchivelogPaths(); }
  getArchivedLogs(): ReadonlyArray<ArchivedLogRecord> { return this._current.getArchivedLogs(); }
  getControlFilePath(): string { return this._current.getControlFilePath(); }
  getControlFilePaths(): ReadonlyArray<string> { return this._current.getControlFilePaths(); }
  getInstanceState(): 'SHUTDOWN' | 'NOMOUNT' | 'MOUNT' | 'OPEN' {
    return this._current.getInstanceState();
  }
  getRecoveryAreaUsedBytes(): number { return this._current.getRecoveryAreaUsedBytes(); }
  checkpointDatafiles(): void { this._current.checkpointDatafiles(); }
  getCurrentScn(): number { return this._current.getCurrentScn(); }
  runSqlStatement(statement: string): SqlStatementOutcome {
    return this._current.runSqlStatement(statement);
  }
  recordBackupPiece(piece: RecordedBackupPiece): void { this._current.recordBackupPiece(piece); }
  recordBlockCorruption(fileNo: number, blocks: number, type: BlockCorruptionType): void {
    this._current.recordBlockCorruption(fileNo, blocks, type);
  }
  getBlockCorruptions(): ReadonlyArray<{ fileNo: number; blocks: number }> {
    return this._current.getBlockCorruptions();
  }
  clearBlockCorruption(fileNo: number): void { this._current.clearBlockCorruption(fileNo); }
  recordBackupCorruption(entry: {
    setStamp: number; fileNo: number; blocks: number;
    markedCorrupt: boolean; type: BlockCorruptionType; kind: 'BACKUPSET' | 'COPY';
  }): void {
    this._current.recordBackupCorruption(entry);
  }

  connectPeer(identifier: string, credentials?: RmanCredentials): ConnectPeerOutcome {
    const resolved = LinuxRmanContext.forTarget(this._localDevice, identifier, credentials);
    if (resolved.ok === false) return { ok: false, error: resolved.error };
    const peer = resolved.ctx;
    return {
      ok: true,
      dbName: peer.dbName,
      dbId: peer.dbId.value,
      remote: resolved.remote,
      runSql: (statement: string) => peer.runSqlStatement(statement),
      context: peer,
    };
  }

  connectTarget(identifier: string, credentials?: RmanCredentials): ConnectTargetOutcome {
    const resolved = LinuxRmanContext.forTarget(this._localDevice, identifier, credentials);
    if (resolved.ok === false) return { ok: false, error: resolved.error };
    this._current = resolved.ctx;
    this._onRetarget?.(resolved.deviceId);
    return {
      ok: true,
      dbName: resolved.ctx.dbName,
      dbId: resolved.ctx.dbId.value,
      remote: resolved.remote,
    };
  }
}

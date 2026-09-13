import type {
  IRmanOracleContext, VfsAdapter, DatafileInfo, ConnectTargetOutcome, RecordedBackupPiece,
  SqlStatementOutcome,
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
  getControlFilePath(): string { return this._current.getControlFilePath(); }
  getInstanceState(): 'SHUTDOWN' | 'NOMOUNT' | 'MOUNT' | 'OPEN' {
    return this._current.getInstanceState();
  }
  getRecoveryAreaUsedBytes(): number { return this._current.getRecoveryAreaUsedBytes(); }
  checkpointDatafiles(): void { this._current.checkpointDatafiles(); }
  runSqlStatement(statement: string): SqlStatementOutcome {
    return this._current.runSqlStatement(statement);
  }
  recordBackupPiece(piece: RecordedBackupPiece): void { this._current.recordBackupPiece(piece); }

  connectTarget(identifier: string): ConnectTargetOutcome {
    const resolved = LinuxRmanContext.forTarget(this._localDevice, identifier);
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

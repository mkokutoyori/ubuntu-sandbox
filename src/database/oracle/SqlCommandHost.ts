import type { ResultSet } from '../engine/executor/ResultSet';
import type { ExecutionContext } from '../engine/executor/BaseExecutor';
import type {
  LockTableStatement, CreateFlashbackArchiveStatement, DropFlashbackArchiveStatement,
  PluggableDatabaseStatement, CreateTypeStatement, AlterTableAction,
  AlterSessionStatement,
} from '../engine/parser/ASTNode';

export type AlterTableStorageAction = Extract<AlterTableAction,
  { action: 'FLASHBACK_ARCHIVE' | 'NO_FLASHBACK_ARCHIVE' | 'INMEMORY' | 'NO_INMEMORY' }>;

export interface SqlCommandHost {
  execLockTable(stmt: LockTableStatement, ctx: ExecutionContext): ResultSet;
  execCreateFlashbackArchive(stmt: CreateFlashbackArchiveStatement, ctx: ExecutionContext): ResultSet;
  execDropFlashbackArchive(stmt: DropFlashbackArchiveStatement, ctx: ExecutionContext): ResultSet;
  execPluggableDatabase(stmt: PluggableDatabaseStatement, ctx: ExecutionContext): ResultSet;
  execCreateType(stmt: CreateTypeStatement, ctx: ExecutionContext): ResultSet;
  execAlterTableStorage(schema: string, table: string, action: AlterTableStorageAction): ResultSet;
  execAlterSession(stmt: AlterSessionStatement, ctx: ExecutionContext): ResultSet;
}

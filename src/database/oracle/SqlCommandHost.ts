import type { ResultSet } from '../engine/executor/ResultSet';
import type { ExecutionContext } from '../engine/executor/BaseExecutor';
import type {
  LockTableStatement, CreateFlashbackArchiveStatement, DropFlashbackArchiveStatement,
  PluggableDatabaseStatement, CreateTypeStatement,
} from '../engine/parser/ASTNode';

export interface SqlCommandHost {
  execLockTable(stmt: LockTableStatement, ctx: ExecutionContext): ResultSet;
  execCreateFlashbackArchive(stmt: CreateFlashbackArchiveStatement, ctx: ExecutionContext): ResultSet;
  execDropFlashbackArchive(stmt: DropFlashbackArchiveStatement, ctx: ExecutionContext): ResultSet;
  execPluggableDatabase(stmt: PluggableDatabaseStatement, ctx: ExecutionContext): ResultSet;
  execCreateType(stmt: CreateTypeStatement, ctx: ExecutionContext): ResultSet;
}

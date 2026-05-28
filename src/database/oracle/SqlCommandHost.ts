import type { ResultSet } from '../engine/executor/ResultSet';
import type { ExecutionContext } from '../engine/executor/BaseExecutor';
import type { LockTableStatement } from '../engine/parser/ASTNode';

export interface SqlCommandHost {
  execLockTable(stmt: LockTableStatement, ctx: ExecutionContext): ResultSet;
}

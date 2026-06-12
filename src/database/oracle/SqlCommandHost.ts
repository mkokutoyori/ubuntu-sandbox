import type { ResultSet } from '../engine/executor/ResultSet';
import type { BaseExecutor } from '../engine/executor/BaseExecutor';
import type { CellValue } from '../engine/storage/BaseStorage';
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
  /** SQL→PL/SQL bridge: evaluate a stored FUNCTION used in a SQL expression. */
  execScalarFunctionCall(executor: BaseExecutor, qualifiedName: string, args: CellValue[]): { handled: boolean; value: CellValue };
  /**
   * Cross-link row source: materialise `schema.table@dbLink` by opening
   * a session on the remote database as the link's CONNECT TO user and
   * running the SELECT there (remote privileges apply). Throws the real
   * error ladder: ORA-02019 unknown link, TNS errors from resolution,
   * ORA-01017 bad link credentials, ORA-00942 unknown remote table.
   */
  fetchDbLinkRows(currentUser: string, dbLink: string, schema: string | undefined, table: string):
    { rows: CellValue[][]; columns: { name: string; dataType: string }[] };
}

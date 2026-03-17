/**
 * OracleExecutor — Executes parsed SQL statements against Oracle storage.
 *
 * Handles SELECT, INSERT, UPDATE, DELETE, DDL, DCL, and admin commands.
 */

import { BaseExecutor, type ExecutionContext } from '../engine/executor/BaseExecutor';
import { type ResultSet, emptyResult, queryResult, type ColumnMeta, type Row } from '../engine/executor/ResultSet';
import type { Statement, SelectStatement, InsertStatement, UpdateStatement, DeleteStatement,
  CreateTableStatement, DropTableStatement, TruncateTableStatement, AlterTableStatement,
  CreateIndexStatement, DropIndexStatement, CreateSequenceStatement, DropSequenceStatement,
  CreateViewStatement, DropViewStatement, GrantStatement, RevokeStatement,
  CreateUserStatement, AlterUserStatement, DropUserStatement, CreateRoleStatement, DropRoleStatement,
  CommitStatement, RollbackStatement, StartupStatement, ShutdownStatement,
  AlterSystemStatement, AlterDatabaseStatement, CreateTablespaceStatement, DropTablespaceStatement,
  Expression, IdentifierExpr, LiteralExpr, BinaryExpr, UnaryExpr, FunctionCallExpr,
  StarExpr, IsNullExpr, BetweenExpr, InExpr, LikeExpr, CaseExpr, SelectItem,
} from '../engine/parser/ASTNode';
import type { OracleStorage } from './OracleStorage';
import type { OracleCatalog } from './OracleCatalog';
import type { OracleInstance } from './OracleInstance';
import { type CellValue, type StorageRow, type ColumnMeta as StorageColMeta, type ConstraintMeta } from '../engine/storage/BaseStorage';
import { parseOracleType } from '../engine/catalog/DataType';
import { OracleError } from '../engine/types/DatabaseError';

export class OracleExecutor extends BaseExecutor {
  private instance: OracleInstance;

  constructor(
    storage: OracleStorage,
    catalog: OracleCatalog,
    instance: OracleInstance,
    context: ExecutionContext
  ) {
    super(storage, catalog, context);
    this.instance = instance;
  }

  execute(statement: Statement): ResultSet {
    switch (statement.type) {
      case 'SelectStatement': return this.executeSelect(statement);
      case 'InsertStatement': return this.executeInsert(statement);
      case 'UpdateStatement': return this.executeUpdate(statement);
      case 'DeleteStatement': return this.executeDelete(statement);
      case 'CreateTableStatement': return this.executeCreateTable(statement);
      case 'DropTableStatement': return this.executeDropTable(statement);
      case 'TruncateTableStatement': return this.executeTruncate(statement);
      case 'AlterTableStatement': return this.executeAlterTable(statement);
      case 'CreateIndexStatement': return this.executeCreateIndex(statement);
      case 'DropIndexStatement': return this.executeDropIndex(statement);
      case 'CreateSequenceStatement': return this.executeCreateSequence(statement);
      case 'DropSequenceStatement': return this.executeDropSequence(statement);
      case 'CreateViewStatement': return emptyResult('View created.');
      case 'DropViewStatement': return emptyResult('View dropped.');
      case 'GrantStatement': return this.executeGrant(statement);
      case 'RevokeStatement': return this.executeRevoke(statement);
      case 'CreateUserStatement': return this.executeCreateUser(statement);
      case 'AlterUserStatement': return this.executeAlterUser(statement);
      case 'DropUserStatement': return this.executeDropUser(statement);
      case 'CreateRoleStatement': return this.executeCreateRole(statement);
      case 'DropRoleStatement': return this.executeDropRole(statement);
      case 'CommitStatement': return emptyResult('Commit complete.');
      case 'RollbackStatement': return emptyResult(statement.savepoint ? `Rollback to savepoint ${statement.savepoint} complete.` : 'Rollback complete.');
      case 'SavepointStatement': return emptyResult('Savepoint created.');
      case 'StartupStatement': return this.executeStartup(statement);
      case 'ShutdownStatement': return this.executeShutdown(statement);
      case 'AlterSystemStatement': return this.executeAlterSystem(statement);
      case 'AlterDatabaseStatement': return this.executeAlterDatabase(statement);
      case 'CreateTablespaceStatement': return this.executeCreateTablespace(statement);
      case 'DropTablespaceStatement': return this.executeDropTablespace(statement);
      default:
        throw new OracleError(900, `Unsupported statement type: ${statement.type}`);
    }
  }

  // ── SELECT ────────────────────────────────────────────────────────

  private executeSelect(stmt: SelectStatement): ResultSet {
    // Check for system catalog view queries
    if (stmt.from && stmt.from.length === 1 && stmt.from[0].type === 'TableRef') {
      const tableRef = stmt.from[0];
      const tableName = tableRef.name.toUpperCase();

      // DUAL
      if (tableName === 'DUAL') {
        return this.executeSelectFromDual(stmt);
      }

      // V$ views, DBA_ views, etc.
      const catalogResult = (this.catalog as OracleCatalog).queryCatalogView(tableName, this.context.currentUser);
      if (catalogResult) {
        return this.applySelectClauses(catalogResult, stmt);
      }
    }

    // Regular table query
    return this.executeSelectFromTable(stmt);
  }

  private executeSelectFromDual(stmt: SelectStatement): ResultSet {
    const columns: ColumnMeta[] = [];
    const row: CellValue[] = [];

    for (const item of stmt.columns) {
      const colName = item.alias || this.exprToString(item.expr);
      const value = this.evaluateExpression(item.expr, [], []);
      columns.push({ name: colName, dataType: parseOracleType('VARCHAR2', 4000) });
      row.push(value);
    }

    return queryResult(columns, [row]);
  }

  private executeSelectFromTable(stmt: SelectStatement): ResultSet {
    if (!stmt.from || stmt.from.length === 0) {
      // No FROM — treat like SELECT FROM DUAL
      return this.executeSelectFromDual(stmt);
    }

    const tableRef = stmt.from[0];
    if (tableRef.type !== 'TableRef') {
      throw new OracleError(942, 'Subquery in FROM not yet supported');
    }

    const schema = (tableRef.schema || this.context.currentSchema).toUpperCase();
    const tableName = tableRef.name.toUpperCase();

    if (!this.storage.tableExists(schema, tableName)) {
      throw new OracleError(942, `table or view does not exist`);
    }

    const tableMeta = this.storage.getTableMeta(schema, tableName)!;
    let rows = this.storage.getRows(schema, tableName);

    // WHERE filter
    if (stmt.where) {
      rows = rows.filter(row => this.evaluateCondition(stmt.where!, row, tableMeta.columns));
    }

    // ORDER BY
    if (stmt.orderBy && stmt.orderBy.length > 0) {
      rows = [...rows]; // Don't mutate original
      rows.sort((a, b) => {
        for (const ob of stmt.orderBy!) {
          const colIdx = this.resolveColumnIndex(ob.expr, tableMeta.columns);
          if (colIdx < 0) continue;
          const va = a[colIdx];
          const vb = b[colIdx];
          let cmp = this.compareValues(va, vb);
          if (ob.direction === 'DESC') cmp = -cmp;
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    }

    // SELECT columns
    const resultColumns: ColumnMeta[] = [];
    const resultRows: Row[] = [];

    // Expand * or specific columns
    const selectCols = this.expandSelectItems(stmt.columns, tableMeta.columns);

    for (const col of selectCols) {
      resultColumns.push({ name: col.alias || col.name, dataType: col.dataType });
    }

    for (const row of rows) {
      const resultRow: CellValue[] = [];
      for (const col of selectCols) {
        if (col.colIndex >= 0) {
          resultRow.push(row[col.colIndex]);
        } else if (col.expr) {
          resultRow.push(this.evaluateExpression(col.expr, row, tableMeta.columns));
        } else {
          resultRow.push(null);
        }
      }
      resultRows.push(resultRow);
    }

    // DISTINCT
    if (stmt.distinct) {
      const seen = new Set<string>();
      const uniqueRows: Row[] = [];
      for (const row of resultRows) {
        const key = JSON.stringify(row);
        if (!seen.has(key)) { seen.add(key); uniqueRows.push(row); }
      }
      return queryResult(resultColumns, uniqueRows);
    }

    // FETCH/OFFSET
    let finalRows = resultRows;
    if (stmt.fetch) {
      let offset = 0;
      if (stmt.fetch.offset) {
        offset = Number(this.evaluateExpression(stmt.fetch.offset, [], []));
      }
      let limit = finalRows.length;
      if (stmt.fetch.count) {
        limit = Number(this.evaluateExpression(stmt.fetch.count, [], []));
      }
      finalRows = finalRows.slice(offset, offset + limit);
    }

    return queryResult(resultColumns, finalRows);
  }

  private applySelectClauses(result: ResultSet, stmt: SelectStatement): ResultSet {
    let rows = result.rows;

    // WHERE
    if (stmt.where) {
      rows = rows.filter(row => {
        const colMetas: StorageColMeta[] = result.columns.map((c, i) => ({
          name: c.name, dataType: c.dataType, ordinalPosition: i,
        }));
        return this.evaluateCondition(stmt.where!, row as StorageRow, colMetas);
      });
    }

    // ORDER BY
    if (stmt.orderBy && stmt.orderBy.length > 0) {
      rows = [...rows];
      rows.sort((a, b) => {
        for (const ob of stmt.orderBy!) {
          const colMetas: StorageColMeta[] = result.columns.map((c, i) => ({
            name: c.name, dataType: c.dataType, ordinalPosition: i,
          }));
          const colIdx = this.resolveColumnIndex(ob.expr, colMetas);
          if (colIdx < 0) continue;
          let cmp = this.compareValues(a[colIdx], b[colIdx]);
          if (ob.direction === 'DESC') cmp = -cmp;
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    }

    return { ...result, rows };
  }

  // ── INSERT ────────────────────────────────────────────────────────

  private executeInsert(stmt: InsertStatement): ResultSet {
    const schema = (stmt.table.schema || this.context.currentSchema).toUpperCase();
    const tableName = stmt.table.name.toUpperCase();

    if (!this.storage.tableExists(schema, tableName)) {
      throw new OracleError(942, `table or view does not exist`);
    }

    const tableMeta = this.storage.getTableMeta(schema, tableName)!;
    let insertedCount = 0;

    if (stmt.values) {
      for (const valueList of stmt.values) {
        const row = this.buildInsertRow(tableMeta, stmt.columns, valueList);
        this.validateConstraints(schema, tableName, tableMeta, row);
        this.storage.insertRow(schema, tableName, row);
        insertedCount++;
      }
    }

    return emptyResult(`${insertedCount} row${insertedCount !== 1 ? 's' : ''} inserted.`, insertedCount);
  }

  private buildInsertRow(tableMeta: import('../engine/storage/BaseStorage').TableMeta, columns: string[] | undefined, values: Expression[]): StorageRow {
    const row: StorageRow = new Array(tableMeta.columns.length).fill(null);

    if (columns) {
      for (let i = 0; i < columns.length && i < values.length; i++) {
        const colIdx = tableMeta.columns.findIndex(c => c.name.toUpperCase() === columns[i].toUpperCase());
        if (colIdx >= 0) {
          row[colIdx] = this.evaluateExpression(values[i], [], []);
        }
      }
    } else {
      for (let i = 0; i < values.length && i < tableMeta.columns.length; i++) {
        row[i] = this.evaluateExpression(values[i], [], []);
      }
    }

    // Apply defaults for missing values
    for (let i = 0; i < tableMeta.columns.length; i++) {
      if (row[i] === null && tableMeta.columns[i].defaultValue !== undefined) {
        row[i] = tableMeta.columns[i].defaultValue!;
      }
    }

    return row;
  }

  // ── UPDATE ────────────────────────────────────────────────────────

  private executeUpdate(stmt: UpdateStatement): ResultSet {
    const schema = (stmt.table.schema || this.context.currentSchema).toUpperCase();
    const tableName = stmt.table.name.toUpperCase();

    if (!this.storage.tableExists(schema, tableName)) {
      throw new OracleError(942, `table or view does not exist`);
    }

    const tableMeta = this.storage.getTableMeta(schema, tableName)!;

    const count = this.storage.updateRows(
      schema, tableName,
      (row) => !stmt.where || this.evaluateCondition(stmt.where, row, tableMeta.columns),
      (row) => {
        const newRow = [...row];
        for (const assign of stmt.assignments) {
          const colIdx = tableMeta.columns.findIndex(c => c.name.toUpperCase() === assign.column.toUpperCase());
          if (colIdx >= 0) {
            newRow[colIdx] = this.evaluateExpression(assign.value, row, tableMeta.columns);
          }
        }
        return newRow;
      }
    );

    return emptyResult(`${count} row${count !== 1 ? 's' : ''} updated.`, count);
  }

  // ── DELETE ────────────────────────────────────────────────────────

  private executeDelete(stmt: DeleteStatement): ResultSet {
    const schema = (stmt.table.schema || this.context.currentSchema).toUpperCase();
    const tableName = stmt.table.name.toUpperCase();

    if (!this.storage.tableExists(schema, tableName)) {
      throw new OracleError(942, `table or view does not exist`);
    }

    const tableMeta = this.storage.getTableMeta(schema, tableName)!;

    const count = this.storage.deleteRows(
      schema, tableName,
      (row) => !stmt.where || this.evaluateCondition(stmt.where, row, tableMeta.columns),
    );

    return emptyResult(`${count} row${count !== 1 ? 's' : ''} deleted.`, count);
  }

  // ── DDL ───────────────────────────────────────────────────────────

  private executeCreateTable(stmt: CreateTableStatement): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    const tableName = stmt.name.toUpperCase();

    if (this.storage.tableExists(schema, tableName)) {
      throw new OracleError(955, `name is already used by an existing object`);
    }

    const columns: StorageColMeta[] = stmt.columns.map((col, i) => ({
      name: col.name.toUpperCase(),
      dataType: parseOracleType(col.dataType.name, col.dataType.precision, col.dataType.scale),
      ordinalPosition: i,
    }));

    const constraints: ConstraintMeta[] = [];
    let constraintIdx = 0;

    // Column-level constraints
    for (const col of stmt.columns) {
      for (const cc of col.constraints) {
        const name = cc.constraintName || `SYS_C${String(10000 + constraintIdx++).padStart(6, '0')}`;
        if (cc.constraintType === 'NOT_NULL') {
          constraints.push({ name, type: 'NOT_NULL', columns: [col.name.toUpperCase()] });
          const colMeta = columns.find(c => c.name === col.name.toUpperCase());
          if (colMeta) colMeta.dataType = { ...colMeta.dataType, nullable: false };
        } else if (cc.constraintType === 'PRIMARY_KEY') {
          constraints.push({ name, type: 'PRIMARY_KEY', columns: [col.name.toUpperCase()] });
          const colMeta = columns.find(c => c.name === col.name.toUpperCase());
          if (colMeta) colMeta.dataType = { ...colMeta.dataType, nullable: false };
        } else if (cc.constraintType === 'UNIQUE') {
          constraints.push({ name, type: 'UNIQUE', columns: [col.name.toUpperCase()] });
        } else if (cc.constraintType === 'REFERENCES') {
          constraints.push({ name, type: 'FOREIGN_KEY', columns: [col.name.toUpperCase()], refTable: cc.refTable?.toUpperCase(), refColumns: cc.refColumn ? [cc.refColumn.toUpperCase()] : undefined, onDelete: cc.onDelete });
        }
      }
    }

    // Table-level constraints
    for (const tc of stmt.constraints) {
      const name = tc.constraintName || `SYS_C${String(10000 + constraintIdx++).padStart(6, '0')}`;
      constraints.push({
        name,
        type: tc.constraintType === 'PRIMARY_KEY' ? 'PRIMARY_KEY' : tc.constraintType === 'UNIQUE' ? 'UNIQUE' : tc.constraintType === 'FOREIGN_KEY' ? 'FOREIGN_KEY' : 'CHECK',
        columns: tc.columns.map(c => c.toUpperCase()),
        refTable: tc.refTable?.toUpperCase(),
        refColumns: tc.refColumns?.map(c => c.toUpperCase()),
        onDelete: tc.onDelete,
      });
    }

    this.storage.ensureSchema(schema);
    this.storage.createTable({
      schema, name: tableName, columns, constraints,
      tablespace: stmt.tablespace?.toUpperCase() || 'USERS',
      temporary: stmt.temporary,
      rowCount: 0,
    });

    return emptyResult('Table created.');
  }

  private executeDropTable(stmt: DropTableStatement): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    const tableName = stmt.name.toUpperCase();
    if (!this.storage.tableExists(schema, tableName)) {
      if (stmt.ifExists) return emptyResult('');
      throw new OracleError(942, `table or view does not exist`);
    }
    this.storage.dropTable(schema, tableName);
    return emptyResult('Table dropped.');
  }

  private executeTruncate(stmt: TruncateTableStatement): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    this.storage.truncateTable(schema, stmt.name.toUpperCase());
    return emptyResult('Table truncated.');
  }

  private executeAlterTable(stmt: AlterTableStatement): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    const tableName = stmt.name.toUpperCase();
    if (!this.storage.tableExists(schema, tableName)) {
      throw new OracleError(942, `table or view does not exist`);
    }

    for (const action of stmt.actions) {
      if (action.action === 'ADD_COLUMN') {
        const col = action.column;
        this.storage.addColumn(schema, tableName, {
          name: col.name.toUpperCase(),
          dataType: parseOracleType(col.dataType.name, col.dataType.precision, col.dataType.scale),
          ordinalPosition: this.storage.getTableMeta(schema, tableName)!.columns.length,
        });
      } else if (action.action === 'DROP_COLUMN') {
        this.storage.dropColumn(schema, tableName, action.columnName.toUpperCase());
      }
    }

    return emptyResult('Table altered.');
  }

  private executeCreateIndex(stmt: CreateIndexStatement): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    this.storage.createIndex(schema, {
      name: stmt.name.toUpperCase(),
      tableName: stmt.table.toUpperCase(),
      columns: stmt.columns.map(c => c.name.toUpperCase()),
      unique: !!stmt.unique,
      bitmap: stmt.bitmap,
    });
    return emptyResult('Index created.');
  }

  private executeDropIndex(stmt: DropIndexStatement): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    this.storage.dropIndex(schema, stmt.name.toUpperCase());
    return emptyResult('Index dropped.');
  }

  private executeCreateSequence(stmt: CreateSequenceStatement): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    this.storage.createSequence(schema, {
      name: stmt.name.toUpperCase(),
      currentValue: (stmt.startWith ?? 1) - (stmt.incrementBy ?? 1),
      incrementBy: stmt.incrementBy ?? 1,
      minValue: 1,
      maxValue: stmt.maxValue === 'NOMAXVALUE' ? Number.MAX_SAFE_INTEGER : (typeof stmt.maxValue === 'number' ? stmt.maxValue : 999999999),
      cache: stmt.cache === 'NOCACHE' ? 0 : (typeof stmt.cache === 'number' ? stmt.cache : 20),
      cycle: stmt.cycle ?? false,
    });
    return emptyResult('Sequence created.');
  }

  private executeDropSequence(stmt: DropSequenceStatement): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    this.storage.dropSequence(schema, stmt.name.toUpperCase());
    return emptyResult('Sequence dropped.');
  }

  // ── DCL ───────────────────────────────────────────────────────────

  private executeGrant(stmt: GrantStatement): ResultSet {
    const catalog = this.catalog as OracleCatalog;
    if (stmt.objectName) {
      const schema = stmt.objectSchema || this.context.currentSchema;
      for (const priv of stmt.privileges) {
        catalog.grantTablePrivilege(stmt.grantee, priv, schema, stmt.objectName, stmt.withGrantOption);
      }
    } else {
      for (const priv of stmt.privileges) {
        // Check if it's a role name
        if (catalog.roleExists(priv)) {
          catalog.grantRole(stmt.grantee, priv, stmt.withAdminOption);
        } else {
          catalog.grantSystemPrivilege(stmt.grantee, priv, stmt.withGrantOption);
        }
      }
    }
    return emptyResult('Grant succeeded.');
  }

  private executeRevoke(stmt: RevokeStatement): ResultSet {
    const catalog = this.catalog as OracleCatalog;
    if (stmt.objectName) {
      const schema = stmt.objectSchema || this.context.currentSchema;
      for (const priv of stmt.privileges) {
        catalog.revokeTablePrivilege(stmt.grantee, priv, schema, stmt.objectName);
      }
    } else {
      for (const priv of stmt.privileges) {
        if (catalog.roleExists(priv)) {
          catalog.revokeRole(stmt.grantee, priv);
        } else {
          catalog.revokeSystemPrivilege(stmt.grantee, priv);
        }
      }
    }
    return emptyResult('Revoke succeeded.');
  }

  // ── User/Role management ──────────────────────────────────────────

  private executeCreateUser(stmt: CreateUserStatement): ResultSet {
    const catalog = this.catalog as OracleCatalog;
    if (catalog.userExists(stmt.username)) {
      throw new OracleError(1920, `user name '${stmt.username.toUpperCase()}' conflicts with another user or role name`);
    }
    catalog.createUser({
      username: stmt.username.toUpperCase(),
      defaultTablespace: stmt.defaultTablespace?.toUpperCase() || 'USERS',
      temporaryTablespace: stmt.temporaryTablespace?.toUpperCase() || 'TEMP',
      accountStatus: stmt.accountLocked ? 'LOCKED' : 'OPEN',
      created: new Date(),
      profile: stmt.profile || 'DEFAULT',
    });
    if (stmt.password) catalog.setPassword(stmt.username.toUpperCase(), stmt.password);
    this.storage.ensureSchema(stmt.username.toUpperCase());
    return emptyResult('User created.');
  }

  private executeAlterUser(stmt: AlterUserStatement): ResultSet {
    const catalog = this.catalog as OracleCatalog;
    if (!catalog.userExists(stmt.username)) {
      throw new OracleError(1917, `user or role '${stmt.username.toUpperCase()}' does not exist`);
    }
    if (stmt.password) catalog.setPassword(stmt.username.toUpperCase(), stmt.password);
    if (stmt.accountLock) catalog.lockUser(stmt.username);
    if (stmt.accountUnlock) catalog.unlockUser(stmt.username);
    return emptyResult('User altered.');
  }

  private executeDropUser(stmt: DropUserStatement): ResultSet {
    const catalog = this.catalog as OracleCatalog;
    if (!catalog.userExists(stmt.username)) {
      throw new OracleError(1918, `user '${stmt.username.toUpperCase()}' does not exist`);
    }
    catalog.dropUser(stmt.username);
    return emptyResult('User dropped.');
  }

  private executeCreateRole(stmt: CreateRoleStatement): ResultSet {
    (this.catalog as OracleCatalog).createRole(stmt.name);
    return emptyResult('Role created.');
  }

  private executeDropRole(stmt: DropRoleStatement): ResultSet {
    (this.catalog as OracleCatalog).dropRole(stmt.name);
    return emptyResult('Role dropped.');
  }

  // ── Instance commands ─────────────────────────────────────────────

  private executeStartup(stmt: StartupStatement): ResultSet {
    const output = this.instance.startup(stmt.mode);
    return emptyResult(output.join('\n'));
  }

  private executeShutdown(stmt: ShutdownStatement): ResultSet {
    const output = this.instance.shutdown(stmt.mode);
    return emptyResult(output.join('\n'));
  }

  private executeAlterSystem(stmt: AlterSystemStatement): ResultSet {
    if (stmt.action === 'SET' && stmt.parameter && stmt.value) {
      this.instance.setParameter(stmt.parameter, stmt.value);
      return emptyResult('System altered.');
    }
    if (stmt.action === 'SWITCH LOGFILE') {
      return emptyResult(this.instance.switchLogfile());
    }
    if (stmt.action === 'CHECKPOINT') {
      return emptyResult('System altered.');
    }
    if (stmt.action === 'FLUSH') {
      return emptyResult('System altered.');
    }
    return emptyResult('System altered.');
  }

  private executeAlterDatabase(stmt: AlterDatabaseStatement): ResultSet {
    if (stmt.action === 'ARCHIVELOG') {
      return emptyResult(this.instance.setArchiveLogMode(true));
    }
    if (stmt.action === 'NOARCHIVELOG') {
      return emptyResult(this.instance.setArchiveLogMode(false));
    }
    if (stmt.action === 'OPEN') {
      return emptyResult('Database altered.');
    }
    return emptyResult('Database altered.');
  }

  private executeCreateTablespace(stmt: CreateTablespaceStatement): ResultSet {
    (this.storage as OracleStorage).createTablespace({
      name: stmt.name.toUpperCase(),
      type: stmt.temporary ? 'TEMPORARY' : stmt.undo ? 'UNDO' : 'PERMANENT',
      status: 'ONLINE',
      datafiles: [{ path: stmt.datafile, size: stmt.size, autoextend: stmt.autoextend?.on ?? false }],
      blockSize: 8192,
    });
    return emptyResult('Tablespace created.');
  }

  private executeDropTablespace(stmt: DropTablespaceStatement): ResultSet {
    (this.storage as OracleStorage).dropTablespace(stmt.name);
    return emptyResult('Tablespace dropped.');
  }

  // ── Expression evaluation ─────────────────────────────────────────

  evaluateExpression(expr: Expression, row: StorageRow, columns: StorageColMeta[]): CellValue {
    switch (expr.type) {
      case 'Literal':
        if (expr.dataType === 'null') return null;
        if (expr.dataType === 'number') return Number(expr.value);
        if (expr.dataType === 'date' || expr.dataType === 'timestamp') return new Date(String(expr.value));
        return String(expr.value ?? '');

      case 'Identifier': {
        const colIdx = this.resolveColumnIndex(expr, columns);
        if (colIdx >= 0 && colIdx < row.length) return row[colIdx];
        // Oracle pseudo-columns
        const name = expr.name.toUpperCase();
        if (name === 'SYSDATE' || name === 'CURRENT_DATE') return new Date().toISOString().slice(0, 19).replace('T', ' ');
        if (name === 'SYSTIMESTAMP' || name === 'CURRENT_TIMESTAMP') return new Date().toISOString();
        if (name === 'USER') return this.context.currentUser;
        if (name === 'ROWNUM') return 1; // Simplified
        return null;
      }

      case 'Star': return null;

      case 'BinaryExpr': {
        const left = this.evaluateExpression(expr.left, row, columns);
        const right = this.evaluateExpression(expr.right, row, columns);
        return this.applyBinaryOp(expr.operator, left, right);
      }

      case 'UnaryExpr': {
        const operand = this.evaluateExpression(expr.operand, row, columns);
        if (expr.operator === '-') return typeof operand === 'number' ? -operand : null;
        if (expr.operator === '+') return operand;
        if (expr.operator === 'NOT') return operand ? false : true;
        return null;
      }

      case 'FunctionCall':
        return this.evaluateFunction(expr, row, columns);

      case 'CaseExpr':
        return this.evaluateCase(expr, row, columns);

      case 'ParenExpr':
        return this.evaluateExpression(expr.expr, row, columns);

      case 'SequenceExpr': {
        const schema = expr.schema || this.context.currentSchema;
        if (expr.operation === 'NEXTVAL') return this.storage.nextVal(schema, expr.sequenceName);
        return this.storage.currVal(schema, expr.sequenceName);
      }

      default:
        return null;
    }
  }

  private evaluateCondition(expr: Expression, row: StorageRow, columns: StorageColMeta[]): boolean {
    switch (expr.type) {
      case 'BinaryExpr': {
        if (expr.operator === 'AND') {
          return this.evaluateCondition(expr.left, row, columns) && this.evaluateCondition(expr.right, row, columns);
        }
        if (expr.operator === 'OR') {
          return this.evaluateCondition(expr.left, row, columns) || this.evaluateCondition(expr.right, row, columns);
        }
        const left = this.evaluateExpression(expr.left, row, columns);
        const right = this.evaluateExpression(expr.right, row, columns);
        return this.applyComparison(expr.operator, left, right);
      }
      case 'UnaryExpr':
        if (expr.operator === 'NOT') return !this.evaluateCondition(expr.operand, row, columns);
        return !!this.evaluateExpression(expr, row, columns);
      case 'IsNullExpr': {
        const val = this.evaluateExpression(expr.expr, row, columns);
        return expr.negated ? val !== null : val === null;
      }
      case 'BetweenExpr': {
        const val = this.evaluateExpression(expr.expr, row, columns);
        const low = this.evaluateExpression(expr.low, row, columns);
        const high = this.evaluateExpression(expr.high, row, columns);
        const inRange = this.compareValues(val, low) >= 0 && this.compareValues(val, high) <= 0;
        return expr.negated ? !inRange : inRange;
      }
      case 'InExpr': {
        const val = this.evaluateExpression(expr.expr, row, columns);
        if (Array.isArray(expr.values)) {
          const found = expr.values.some(v => {
            const ev = this.evaluateExpression(v, row, columns);
            return this.compareValues(val, ev) === 0;
          });
          return expr.negated ? !found : found;
        }
        return false; // Subquery IN — not yet supported
      }
      case 'LikeExpr': {
        const val = String(this.evaluateExpression(expr.expr, row, columns) ?? '');
        const pattern = String(this.evaluateExpression(expr.pattern, row, columns) ?? '');
        const regex = new RegExp('^' + pattern.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
        const match = regex.test(val);
        return expr.negated ? !match : match;
      }
      default:
        return !!this.evaluateExpression(expr, row, columns);
    }
  }

  private evaluateFunction(expr: FunctionCallExpr, row: StorageRow, columns: StorageColMeta[]): CellValue {
    const name = expr.name.toUpperCase();
    const args = expr.args.map(a => this.evaluateExpression(a, row, columns));

    switch (name) {
      // String functions
      case 'UPPER': return args[0] != null ? String(args[0]).toUpperCase() : null;
      case 'LOWER': return args[0] != null ? String(args[0]).toLowerCase() : null;
      case 'INITCAP': return args[0] != null ? String(args[0]).replace(/\b\w/g, c => c.toUpperCase()) : null;
      case 'LENGTH': return args[0] != null ? String(args[0]).length : null;
      case 'SUBSTR': {
        if (args[0] == null) return null;
        const str = String(args[0]);
        const start = Number(args[1]) - 1; // Oracle is 1-based
        const len = args[2] != null ? Number(args[2]) : undefined;
        return str.substring(start, len !== undefined ? start + len : undefined);
      }
      case 'INSTR': {
        if (args[0] == null || args[1] == null) return null;
        const idx = String(args[0]).indexOf(String(args[1]));
        return idx >= 0 ? idx + 1 : 0;
      }
      case 'TRIM': return args[0] != null ? String(args[0]).trim() : null;
      case 'LTRIM': return args[0] != null ? String(args[0]).replace(/^\s+/, '') : null;
      case 'RTRIM': return args[0] != null ? String(args[0]).replace(/\s+$/, '') : null;
      case 'LPAD': {
        if (args[0] == null) return null;
        const str = String(args[0]);
        const len = Number(args[1]);
        const pad = args[2] != null ? String(args[2]) : ' ';
        return str.padStart(len, pad);
      }
      case 'RPAD': {
        if (args[0] == null) return null;
        const str = String(args[0]);
        const len = Number(args[1]);
        const pad = args[2] != null ? String(args[2]) : ' ';
        return str.padEnd(len, pad);
      }
      case 'REPLACE': {
        if (args[0] == null) return null;
        return String(args[0]).replaceAll(String(args[1] ?? ''), String(args[2] ?? ''));
      }
      case 'CONCAT': return (args[0] != null ? String(args[0]) : '') + (args[1] != null ? String(args[1]) : '');

      // Numeric functions
      case 'ABS': return args[0] != null ? Math.abs(Number(args[0])) : null;
      case 'CEIL': return args[0] != null ? Math.ceil(Number(args[0])) : null;
      case 'FLOOR': return args[0] != null ? Math.floor(Number(args[0])) : null;
      case 'ROUND': return args[0] != null ? (args[1] != null ? Number(Number(args[0]).toFixed(Number(args[1]))) : Math.round(Number(args[0]))) : null;
      case 'TRUNC': return args[0] != null ? Math.trunc(Number(args[0])) : null;
      case 'MOD': return args[0] != null && args[1] != null ? Number(args[0]) % Number(args[1]) : null;
      case 'POWER': return args[0] != null && args[1] != null ? Math.pow(Number(args[0]), Number(args[1])) : null;
      case 'SQRT': return args[0] != null ? Math.sqrt(Number(args[0])) : null;
      case 'SIGN': return args[0] != null ? Math.sign(Number(args[0])) : null;
      case 'GREATEST': return args.filter(a => a != null).reduce<CellValue>((a, b) => (this.compareValues(a, b) >= 0 ? a : b), args[0]);
      case 'LEAST': return args.filter(a => a != null).reduce<CellValue>((a, b) => (this.compareValues(a, b) <= 0 ? a : b), args[0]);

      // Null handling
      case 'NVL': return args[0] ?? args[1] ?? null;
      case 'NVL2': return args[0] != null ? (args[1] ?? null) : (args[2] ?? null);
      case 'COALESCE': return args.find(a => a != null) ?? null;
      case 'NULLIF': return this.compareValues(args[0], args[1]) === 0 ? null : args[0];
      case 'DECODE': return this.evaluateDecode(args);

      // Date functions
      case 'SYSDATE': return new Date().toISOString().slice(0, 19).replace('T', ' ');
      case 'SYSTIMESTAMP': return new Date().toISOString();
      case 'TO_CHAR': return args[0] != null ? String(args[0]) : null;
      case 'TO_NUMBER': return args[0] != null ? Number(args[0]) : null;
      case 'TO_DATE': return args[0] != null ? String(args[0]) : null;

      // System functions
      case 'USER': return this.context.currentUser;
      case 'SYS_GUID': return 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'.replace(/X/g, () => Math.floor(Math.random() * 16).toString(16).toUpperCase());
      case 'SYS_CONTEXT': return this.context.currentUser; // Simplified

      // COUNT(*) and other aggregates return a single value for a column evaluation context
      // Real aggregation is handled at the query level — here we just return the scalar value
      case 'COUNT': return args.length === 0 || (expr.args[0] && expr.args[0].type === 'Star') ? 1 : (args[0] != null ? 1 : 0);
      case 'SUM': case 'AVG': case 'MIN': case 'MAX': return args[0] ?? null;

      default: return null;
    }
  }

  private evaluateDecode(args: CellValue[]): CellValue {
    if (args.length < 3) return null;
    const expr = args[0];
    for (let i = 1; i + 1 < args.length; i += 2) {
      if (this.compareValues(expr, args[i]) === 0) return args[i + 1];
    }
    // Default (odd number of remaining args)
    return args.length % 2 === 0 ? args[args.length - 1] : null;
  }

  private evaluateCase(expr: CaseExpr, row: StorageRow, columns: StorageColMeta[]): CellValue {
    if (expr.operand) {
      const val = this.evaluateExpression(expr.operand, row, columns);
      for (const wc of expr.whenClauses) {
        const whenVal = this.evaluateExpression(wc.when, row, columns);
        if (this.compareValues(val, whenVal) === 0) return this.evaluateExpression(wc.then, row, columns);
      }
    } else {
      for (const wc of expr.whenClauses) {
        if (this.evaluateCondition(wc.when, row, columns)) return this.evaluateExpression(wc.then, row, columns);
      }
    }
    return expr.elseClause ? this.evaluateExpression(expr.elseClause, row, columns) : null;
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private resolveColumnIndex(expr: Expression, columns: StorageColMeta[]): number {
    if (expr.type === 'Identifier') {
      const name = expr.name.toUpperCase();
      return columns.findIndex(c => c.name === name);
    }
    if (expr.type === 'Literal' && expr.dataType === 'number') {
      return Number(expr.value) - 1; // 1-based in ORDER BY
    }
    return -1;
  }

  private applyBinaryOp(op: string, left: CellValue, right: CellValue): CellValue {
    if (op === '||') return (left != null ? String(left) : '') + (right != null ? String(right) : '');
    if (left == null || right == null) return null;
    const l = Number(left);
    const r = Number(right);
    switch (op) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': if (r === 0) throw new OracleError(1476, 'divisor is equal to zero'); return l / r;
      default: return this.applyComparison(op, left, right) ? 1 : 0;
    }
  }

  private applyComparison(op: string, left: CellValue, right: CellValue): boolean {
    if (left === null || right === null) return false;
    const cmp = this.compareValues(left, right);
    switch (op) {
      case '=': return cmp === 0;
      case '<>': case '!=': return cmp !== 0;
      case '<': return cmp < 0;
      case '>': return cmp > 0;
      case '<=': return cmp <= 0;
      case '>=': return cmp >= 0;
      default: return false;
    }
  }

  private compareValues(a: CellValue, b: CellValue): number {
    if (a === null && b === null) return 0;
    if (a === null) return -1;
    if (b === null) return 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b));
  }

  private validateConstraints(schema: string, tableName: string, tableMeta: import('../engine/storage/BaseStorage').TableMeta, row: StorageRow): void {
    for (const constraint of tableMeta.constraints) {
      if (constraint.type === 'NOT_NULL' || constraint.type === 'PRIMARY_KEY') {
        for (const colName of constraint.columns) {
          const colIdx = tableMeta.columns.findIndex(c => c.name === colName);
          if (colIdx >= 0 && row[colIdx] === null) {
            throw new OracleError(1400, `cannot insert NULL into ("${schema}"."${tableName}"."${colName}")`);
          }
        }
      }
      if (constraint.type === 'PRIMARY_KEY' || constraint.type === 'UNIQUE') {
        const existingRows = this.storage.getRows(schema, tableName);
        const colIndexes = constraint.columns.map(cn => tableMeta.columns.findIndex(c => c.name === cn));
        const newKey = colIndexes.map(i => row[i]);
        for (const existing of existingRows) {
          const existingKey = colIndexes.map(i => existing[i]);
          if (newKey.every((v, i) => this.compareValues(v, existingKey[i]) === 0)) {
            throw new OracleError(1, `unique constraint (${constraint.name}) violated`);
          }
        }
      }
    }
  }

  private expandSelectItems(items: SelectItem[], columns: StorageColMeta[]): { name: string; alias?: string; colIndex: number; dataType: import('../engine/catalog/DataType').ColumnDataType; expr?: Expression }[] {
    const result: { name: string; alias?: string; colIndex: number; dataType: import('../engine/catalog/DataType').ColumnDataType; expr?: Expression }[] = [];
    for (const item of items) {
      if (item.expr.type === 'Star') {
        for (const col of columns) {
          result.push({ name: col.name, colIndex: col.ordinalPosition, dataType: col.dataType });
        }
      } else if (item.expr.type === 'Identifier') {
        const name = item.expr.name.toUpperCase();
        const colIdx = columns.findIndex(c => c.name === name);
        if (colIdx >= 0) {
          result.push({ name: columns[colIdx].name, alias: item.alias, colIndex: colIdx, dataType: columns[colIdx].dataType });
        } else {
          result.push({ name: item.alias || name, colIndex: -1, dataType: parseOracleType('VARCHAR2'), expr: item.expr });
        }
      } else {
        const alias = item.alias || this.exprToString(item.expr);
        result.push({ name: alias, alias: item.alias, colIndex: -1, dataType: parseOracleType('VARCHAR2'), expr: item.expr });
      }
    }
    return result;
  }

  private exprToString(expr: Expression): string {
    switch (expr.type) {
      case 'Literal': return String(expr.value ?? 'NULL');
      case 'Identifier': return expr.name;
      case 'FunctionCall': return `${expr.name}(...)`;
      case 'BinaryExpr': return `${this.exprToString(expr.left)} ${expr.operator} ${this.exprToString(expr.right)}`;
      default: return 'EXPR';
    }
  }
}

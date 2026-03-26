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
  MergeStatement, WithClause, ConnectByClause, ExplainPlanStatement, CreateTriggerStatement, DropTriggerStatement,
  Expression, IdentifierExpr, LiteralExpr, BinaryExpr, UnaryExpr, FunctionCallExpr,
  StarExpr, IsNullExpr, BetweenExpr, InExpr, LikeExpr, CaseExpr, SelectItem, SubqueryExpr,
} from '../engine/parser/ASTNode';
import type { OracleStorage } from './OracleStorage';
import type { OracleCatalog } from './OracleCatalog';
import type { OracleInstance } from './OracleInstance';
import { type CellValue, type StorageRow, type ColumnMeta as StorageColMeta, type ConstraintMeta } from '../engine/storage/BaseStorage';
import { parseOracleType } from '../engine/catalog/DataType';
import { OracleError } from '../engine/types/DatabaseError';

export class OracleExecutor extends BaseExecutor {
  private instance: OracleInstance;
  private _currentRowNum: number = 0;

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
      case 'CreateViewStatement': return this.executeCreateView(statement);
      case 'DropViewStatement': return this.executeDropView(statement);
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
      case 'MergeStatement': return this.executeMerge(statement);
      case 'ExplainPlanStatement': return this.executeExplainPlan(statement);
      case 'CreateTriggerStatement': return this.executeCreateTrigger(statement);
      case 'DropTriggerStatement': return this.executeDropTrigger(statement);
      case 'CreateSynonymStatement': return this.executeCreateSynonym(statement);
      case 'DropSynonymStatement': return this.executeDropSynonym(statement);
      case 'AlterSequenceStatement': return this.executeAlterSequence(statement);
      case 'AlterIndexStatement': return this.executeAlterIndex(statement);
      case 'CreateDbLinkStatement': return emptyResult('Database link created.');
      case 'DropDbLinkStatement': return emptyResult('Database link dropped.');
      case 'CreateMaterializedViewStatement': return emptyResult('Materialized view created.');
      case 'DropMaterializedViewStatement': return emptyResult('Materialized view dropped.');
      default:
        throw new OracleError(900, `Unsupported statement type: ${statement.type}`);
    }
  }

  // ── SELECT ────────────────────────────────────────────────────────

  private executeSelect(stmt: SelectStatement): ResultSet {
    // Handle WITH (CTE) clause — materialize CTEs as temporary tables, execute inner SELECT, then clean up
    if (stmt.withClause) {
      return this.executeWithCTE(stmt);
    }

    // Handle set operations (UNION, INTERSECT, MINUS)
    if (stmt.setOp) {
      return this.executeSetOperation(stmt);
    }

    // Check for system catalog view queries
    if (stmt.from && stmt.from.length === 1 && stmt.from[0].type === 'TableRef') {
      const tableRef = stmt.from[0];
      const tableName = tableRef.name.toUpperCase();

      // DUAL
      if (tableName === 'DUAL') {
        return this.executeSelectFromDual(stmt);
      }

      // V$ views, DBA_ views, etc.
      // Handle SYS-prefixed internal tables (SYS.OBJ$, SYS.TAB$, etc.)
      const catalogViewName = (tableRef.schema?.toUpperCase() === 'SYS' ? `SYS.${tableName}` : tableName);
      const catalogResult = (this.catalog as OracleCatalog).queryCatalogView(catalogViewName, this.context.currentUser);
      if (catalogResult) {
        return this.applySelectClauses(catalogResult, stmt);
      }
    }

    // Regular table query
    return this.executeSelectFromTable(stmt);
  }

  // ── WITH / CTE ──────────────────────────────────────────────────

  private executeWithCTE(stmt: SelectStatement): ResultSet {
    const cteSchema = '__CTE__';
    const cteNames: string[] = [];

    try {
      // Materialize each CTE as a temporary table
      for (const cte of stmt.withClause!.ctes) {
        const cteName = cte.name.toUpperCase();

        // Patch CTE inner query to reference already-materialized CTEs
        const patchedQuery = cteNames.length > 0
          ? this.patchCTERefs({ ...cte.query, type: 'Select' } as SelectStatement, cteNames, cteSchema)
          : cte.query;

        // Execute the CTE query
        const cteResult = this.executeSelect(patchedQuery);

        cteNames.push(cteName);

        // Create a temporary table in a special CTE schema
        const columns: StorageColMeta[] = cteResult.columns.map((col, i) => ({
          name: cte.columns ? cte.columns[i]?.toUpperCase() || col.name : col.name,
          dataType: col.dataType,
          ordinalPosition: i,
        }));

        this.storage.createTable({
          schema: cteSchema, name: cteName, columns, constraints: [],
          tablespace: 'SYSTEM', temporary: true, rowCount: 0,
        });
        for (const row of cteResult.rows) {
          this.storage.insertRow(cteSchema, cteName, row as StorageRow);
        }
      }

      // Execute the main SELECT with CTEs available. Temporarily make CTE tables
      // visible by patching FROM references to use the CTE schema.
      const patchedStmt = this.patchCTERefs(stmt, cteNames, cteSchema);

      return this.executeSelect({ ...patchedStmt, withClause: undefined });
    } finally {
      // Clean up CTE tables
      for (const cteName of cteNames) {
        try { this.storage.dropTable(cteSchema, cteName); } catch { /* ignore */ }
      }
    }
  }

  private patchCTERefs(stmt: SelectStatement, cteNames: string[], cteSchema: string): SelectStatement {
    const patched = { ...stmt };

    // Patch FROM references
    if (patched.from) {
      patched.from = patched.from.map(ref => {
        if (ref.type === 'TableRef' && cteNames.includes(ref.name.toUpperCase()) && !ref.schema) {
          return { ...ref, schema: cteSchema };
        }
        return ref;
      });
    }

    // Patch JOIN references
    if (patched.joins) {
      patched.joins = patched.joins.map(join => {
        if (join.table.type === 'TableRef' && cteNames.includes(join.table.name.toUpperCase()) && !join.table.schema) {
          return { ...join, table: { ...join.table, schema: cteSchema } };
        }
        return join;
      });
    }

    return patched;
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
      return this.executeSelectFromDual(stmt);
    }

    // ── Step 1: Build combined row set (FROM + JOINs) ──────────────
    let { rows, columns } = this.resolveFromClause(stmt);

    // ── Step 2: WHERE filter ───────────────────────────────────────
    if (stmt.where) {
      this._currentRowNum = 0;
      const filtered: StorageRow[] = [];
      for (const row of rows) {
        this._currentRowNum++;
        if (this.evaluateCondition(stmt.where!, row, columns)) {
          filtered.push(row);
        }
      }
      rows = filtered;
    }

    // ── Step 2b: CONNECT BY (hierarchical query) ─────────────────
    if (stmt.connectBy) {
      rows = this.executeConnectBy(rows, columns, stmt.connectBy);
    }

    // ── Step 3: GROUP BY + aggregation ─────────────────────────────
    const hasAggregates = this.selectHasAggregates(stmt.columns);
    if (stmt.groupBy || hasAggregates) {
      const grouped = this.performGroupBy(rows, columns, stmt);
      // HAVING filter on groups
      if (stmt.having) {
        const filteredGroups: { key: CellValue[]; rows: StorageRow[] }[] = [];
        for (const group of grouped) {
          if (this.evaluateConditionAggregate(stmt.having, group.rows, columns)) {
            filteredGroups.push(group);
          }
        }
        return this.projectGroupedRows(filteredGroups, columns, stmt);
      }
      return this.projectGroupedRows(grouped, columns, stmt);
    }

    // ── Step 4: SELECT columns (with window function support) ─────
    const selectCols = this.expandSelectItems(stmt.columns, columns);
    const resultColumns: ColumnMeta[] = selectCols.map(col => ({ name: col.alias || col.name, dataType: col.dataType }));

    // Check for window functions
    const windowColIndices: number[] = [];
    for (let i = 0; i < stmt.columns.length; i++) {
      if (stmt.columns[i].expr.type === 'FunctionCall' && stmt.columns[i].expr.over) {
        windowColIndices.push(i);
      }
    }

    let resultRows: Row[] = rows.map(row => {
      return selectCols.map(col => {
        if (col.colIndex >= 0) return row[col.colIndex];
        if (col.expr) {
          // Skip window function evaluation here — handled below
          if (col.expr.type === 'FunctionCall' && (col.expr as FunctionCallExpr).over) return null;
          return this.evaluateExpression(col.expr, row, columns);
        }
        return null;
      });
    });

    // ── Step 4b: Evaluate window functions ────────────────────────
    if (windowColIndices.length > 0) {
      this.evaluateWindowFunctions(resultRows, rows, columns, stmt.columns, windowColIndices);
    }

    // ── Step 5: DISTINCT ───────────────────────────────────────────
    if (stmt.distinct) {
      const seen = new Set<string>();
      resultRows = resultRows.filter(row => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // ── Step 6: ORDER BY ───────────────────────────────────────────
    if (stmt.orderBy && stmt.orderBy.length > 0) {
      resultRows.sort((a, b) => {
        for (const ob of stmt.orderBy!) {
          // Try to resolve by column alias or position in result set
          let idx = this.resolveOrderByIndex(ob.expr, selectCols, columns);
          if (idx < 0) continue;
          let cmp = this.compareValues(a[idx], b[idx]);
          if (ob.direction === 'DESC') cmp = -cmp;
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    }

    // ── Step 7: FETCH/OFFSET ───────────────────────────────────────
    if (stmt.fetch) {
      let offset = 0;
      if (stmt.fetch.offset) offset = Number(this.evaluateExpression(stmt.fetch.offset, [], []));
      let limit = resultRows.length;
      if (stmt.fetch.count) limit = Number(this.evaluateExpression(stmt.fetch.count, [], []));
      resultRows = resultRows.slice(offset, offset + limit);
    }

    return queryResult(resultColumns, resultRows);
  }

  // ── FROM + JOIN resolution ─────────────────────────────────────

  private resolveFromClause(stmt: SelectStatement): { rows: StorageRow[]; columns: StorageColMeta[] } {
    const firstRef = stmt.from![0];
    let { rows, columns } = this.loadTableReference(firstRef);

    // Handle additional FROM references (comma-separated → implicit CROSS JOIN)
    for (let i = 1; i < stmt.from!.length; i++) {
      const right = this.loadTableReference(stmt.from![i]);
      const crossJoin: import('../engine/parser/ASTNode').JoinClause = {
        joinType: 'CROSS',
        table: stmt.from![i],
      };
      const result = this.performJoin(rows, columns, right.rows, right.columns, crossJoin);
      rows = result.rows;
      columns = result.columns;
    }

    // Process JOINs
    if (stmt.joins) {
      for (const join of stmt.joins) {
        const right = this.loadTableReference(join.table);
        const result = this.performJoin(rows, columns, right.rows, right.columns, join);
        rows = result.rows;
        columns = result.columns;
      }
    }

    return { rows, columns };
  }

  private loadTableReference(ref: import('../engine/parser/ASTNode').TableReference): { rows: StorageRow[]; columns: StorageColMeta[] } {
    if (ref.type === 'TableRef') {
      return this.loadTable(ref);
    }
    // SubqueryTableRef — inline view
    const result = this.executeSelect(ref.query);
    const alias = ref.alias?.toUpperCase() || 'SUBQUERY';
    const columns: StorageColMeta[] = result.columns.map((c: ColumnMeta, i: number) => ({
      name: c.name,
      dataType: c.dataType || 'VARCHAR2',
      ordinalPosition: i,
      _qualifiedNames: [c.name, `${alias}.${c.name}`],
    } as StorageColMeta & { _qualifiedNames: string[] }));
    const rows: StorageRow[] = result.rows.map((r: Row) => [...r]);
    return { rows, columns };
  }

  private loadTable(ref: import('../engine/parser/ASTNode').TableRef): { rows: StorageRow[]; columns: StorageColMeta[] } {
    const schema = (ref.schema || this.context.currentSchema).toUpperCase();
    const tableName = ref.name.toUpperCase();
    const alias = ref.alias?.toUpperCase();

    // Check if it's a view first
    const viewMeta = this.storage.getViewMeta(schema, tableName);
    if (viewMeta) {
      return this.loadView(viewMeta, alias || tableName);
    }

    if (!this.storage.tableExists(schema, tableName)) {
      throw new OracleError(942, `table or view does not exist`);
    }

    const meta = this.storage.getTableMeta(schema, tableName)!;
    const rows = this.storage.getRows(schema, tableName);

    // Prefix column names with alias or table name for disambiguation
    const prefix = alias || tableName;
    const columns: StorageColMeta[] = meta.columns.map((c, i) => ({
      ...c,
      name: c.name,
      ordinalPosition: i,
      _qualifiedNames: [c.name, `${prefix}.${c.name}`],
    } as StorageColMeta & { _qualifiedNames: string[] }));

    return { rows, columns };
  }

  private loadView(viewMeta: import('../engine/storage/BaseStorage').ViewMeta, prefix: string): { rows: StorageRow[]; columns: StorageColMeta[] } {
    // Execute the stored query AST
    if (!viewMeta.queryAST) {
      throw new OracleError(942, `view ${viewMeta.name} has no query`);
    }
    const result = this.executeSelect(viewMeta.queryAST as SelectStatement);

    // Convert ResultSet rows back to StorageRow format
    const columns: StorageColMeta[] = result.columns.map((c: ColumnMeta, i: number) => {
      const colName = viewMeta.columns?.[i] || c.name;
      return {
        name: colName,
        dataType: c.dataType || 'VARCHAR2',
        ordinalPosition: i,
        _qualifiedNames: [colName, `${prefix}.${colName}`],
      } as StorageColMeta & { _qualifiedNames: string[] };
    });
    const rows: StorageRow[] = result.rows.map((r: Row) => [...r]);

    return { rows, columns };
  }

  private performJoin(
    leftRows: StorageRow[], leftCols: StorageColMeta[],
    rightRows: StorageRow[], rightCols: StorageColMeta[],
    join: import('../engine/parser/ASTNode').JoinClause
  ): { rows: StorageRow[]; columns: StorageColMeta[] } {
    const combinedCols: StorageColMeta[] = [
      ...leftCols.map((c, i) => ({ ...c, ordinalPosition: i })),
      ...rightCols.map((c, i) => ({ ...c, ordinalPosition: leftCols.length + i })),
    ];
    const nullRight = new Array(rightCols.length).fill(null);
    const nullLeft = new Array(leftCols.length).fill(null);

    if (join.joinType === 'CROSS') {
      const rows: StorageRow[] = [];
      for (const l of leftRows) {
        for (const r of rightRows) {
          rows.push([...l, ...r]);
        }
      }
      return { rows, columns: combinedCols };
    }

    const resultRows: StorageRow[] = [];
    const leftMatched = new Set<number>();
    const rightMatched = new Set<number>();

    for (let li = 0; li < leftRows.length; li++) {
      let matched = false;
      for (let ri = 0; ri < rightRows.length; ri++) {
        const combined = [...leftRows[li], ...rightRows[ri]];
        if (!join.on || this.evaluateCondition(join.on, combined, combinedCols)) {
          resultRows.push(combined);
          leftMatched.add(li);
          rightMatched.add(ri);
          matched = true;
        }
      }
      // LEFT / FULL: unmatched left rows
      if (!matched && (join.joinType === 'LEFT' || join.joinType === 'FULL')) {
        resultRows.push([...leftRows[li], ...nullRight]);
        leftMatched.add(li);
      }
    }

    // RIGHT / FULL: unmatched right rows
    if (join.joinType === 'RIGHT' || join.joinType === 'FULL') {
      for (let ri = 0; ri < rightRows.length; ri++) {
        if (!rightMatched.has(ri)) {
          resultRows.push([...nullLeft, ...rightRows[ri]]);
        }
      }
    }

    // INNER: only matched rows (already in resultRows from the loop)
    return { rows: resultRows, columns: combinedCols };
  }

  // ── GROUP BY + Aggregation ─────────────────────────────────────

  private selectHasAggregates(items: SelectItem[]): boolean {
    return items.some(item => this.exprHasAggregate(item.expr));
  }

  private exprHasAggregate(expr: Expression): boolean {
    if (expr.type === 'FunctionCall') {
      // Window functions (with OVER) are NOT regular aggregates
      if ((expr as FunctionCallExpr).over) return false;
      const name = expr.name.toUpperCase();
      if (['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'MEDIAN', 'STDDEV', 'VARIANCE', 'LISTAGG'].includes(name)) return true;
    }
    if (expr.type === 'BinaryExpr') {
      return this.exprHasAggregate(expr.left) || this.exprHasAggregate(expr.right);
    }
    return false;
  }

  private performGroupBy(rows: StorageRow[], columns: StorageColMeta[], stmt: SelectStatement): { key: CellValue[]; rows: StorageRow[] }[] {
    if (!stmt.groupBy || stmt.groupBy.length === 0) {
      // No GROUP BY but has aggregates — treat all rows as one group
      return [{ key: [], rows }];
    }

    const groupMap = new Map<string, { key: CellValue[]; rows: StorageRow[] }>();
    for (const row of rows) {
      const keyValues = stmt.groupBy!.map(expr => this.evaluateExpression(expr, row, columns));
      const keyStr = JSON.stringify(keyValues);
      if (!groupMap.has(keyStr)) {
        groupMap.set(keyStr, { key: keyValues, rows: [] });
      }
      groupMap.get(keyStr)!.rows.push(row);
    }

    return Array.from(groupMap.values());
  }

  private projectGroupedRows(
    groups: { key: CellValue[]; rows: StorageRow[] }[],
    columns: StorageColMeta[],
    stmt: SelectStatement
  ): ResultSet {
    const resultColumns: ColumnMeta[] = [];
    const resultRows: Row[] = [];

    // Build column metadata from first call
    for (const item of stmt.columns) {
      const name = item.alias || this.exprToString(item.expr);
      resultColumns.push({ name, dataType: parseOracleType('VARCHAR2') });
    }

    for (const group of groups) {
      const row: CellValue[] = [];
      for (const item of stmt.columns) {
        row.push(this.evaluateExpressionGrouped(item.expr, group.rows, columns));
      }
      resultRows.push(row);
    }

    // ORDER BY on grouped results
    if (stmt.orderBy && stmt.orderBy.length > 0) {
      resultRows.sort((a, b) => {
        for (const ob of stmt.orderBy!) {
          const idx = this.resolveOrderByIndexGrouped(ob.expr, stmt.columns, columns);
          if (idx < 0) continue;
          let cmp = this.compareValues(a[idx], b[idx]);
          if (ob.direction === 'DESC') cmp = -cmp;
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    }

    return queryResult(resultColumns, resultRows);
  }

  // ── Window Function Evaluation ──────────────────────────────────

  private evaluateWindowFunctions(
    resultRows: Row[],
    sourceRows: StorageRow[],
    sourceColumns: StorageColMeta[],
    selectItems: SelectItem[],
    windowColIndices: number[]
  ): void {
    for (const colIdx of windowColIndices) {
      const funcExpr = selectItems[colIdx].expr as FunctionCallExpr;
      const windowSpec = funcExpr.over!;
      const funcName = funcExpr.name.toUpperCase();

      // Build array of { sourceRowIdx, partitionKey }
      const rowInfos: { srcIdx: number; partKey: string }[] = sourceRows.map((row, i) => {
        const partValues = (windowSpec.partitionBy || []).map(e => this.evaluateExpression(e, row, sourceColumns));
        return { srcIdx: i, partKey: JSON.stringify(partValues) };
      });

      // Group by partition key
      const partitions = new Map<string, number[]>();
      for (let i = 0; i < rowInfos.length; i++) {
        const key = rowInfos[i].partKey;
        if (!partitions.has(key)) partitions.set(key, []);
        partitions.get(key)!.push(i);
      }

      // For each partition, sort indices by window ORDER BY and compute
      for (const [, indices] of partitions) {
        // Sort within partition
        if (windowSpec.orderBy && windowSpec.orderBy.length > 0) {
          indices.sort((a, b) => {
            for (const ob of windowSpec.orderBy!) {
              const va = this.evaluateExpression(ob.expr, sourceRows[a], sourceColumns);
              const vb = this.evaluateExpression(ob.expr, sourceRows[b], sourceColumns);
              let cmp = this.compareValues(va, vb);
              if (ob.direction === 'DESC') cmp = -cmp;
              if (cmp !== 0) return cmp;
            }
            return 0;
          });
        }

        // Evaluate function for each row in partition
        for (let posInPartition = 0; posInPartition < indices.length; posInPartition++) {
          const rowIdx = indices[posInPartition];
          const value = this.computeWindowValue(
            funcName, funcExpr, windowSpec, sourceRows, sourceColumns,
            indices, posInPartition, rowIdx
          );
          resultRows[rowIdx][colIdx] = value;
        }
      }
    }
  }

  private computeWindowValue(
    funcName: string,
    funcExpr: FunctionCallExpr,
    windowSpec: import('../engine/parser/ASTNode').WindowSpec,
    sourceRows: StorageRow[],
    sourceColumns: StorageColMeta[],
    partitionIndices: number[],
    posInPartition: number,
    rowIdx: number
  ): CellValue {
    switch (funcName) {
      case 'ROW_NUMBER':
        return posInPartition + 1;

      case 'RANK': {
        // Rank with gaps: same rank for ties, gap after
        if (posInPartition === 0) return 1;
        // Compare with previous row
        const prev = partitionIndices[posInPartition - 1];
        const isTie = this.windowRowsEqual(windowSpec, sourceRows[prev], sourceRows[rowIdx], sourceColumns);
        // Get previous rank
        let rank = 1;
        for (let i = 1; i <= posInPartition; i++) {
          const iPrev = partitionIndices[i - 1];
          const iCurr = partitionIndices[i];
          if (!this.windowRowsEqual(windowSpec, sourceRows[iPrev], sourceRows[iCurr], sourceColumns)) {
            rank = i + 1;
          }
        }
        return rank;
      }

      case 'DENSE_RANK': {
        if (posInPartition === 0) return 1;
        let denseRank = 1;
        for (let i = 1; i <= posInPartition; i++) {
          const iPrev = partitionIndices[i - 1];
          const iCurr = partitionIndices[i];
          if (!this.windowRowsEqual(windowSpec, sourceRows[iPrev], sourceRows[iCurr], sourceColumns)) {
            denseRank++;
          }
        }
        return denseRank;
      }

      case 'NTILE': {
        const nBuckets = funcExpr.args.length > 0
          ? Number(this.evaluateExpression(funcExpr.args[0], sourceRows[rowIdx], sourceColumns))
          : 1;
        const totalRows = partitionIndices.length;
        return Math.floor(posInPartition * nBuckets / totalRows) + 1;
      }

      case 'LAG': {
        const offset = funcExpr.args.length > 1
          ? Number(this.evaluateExpression(funcExpr.args[1], sourceRows[rowIdx], sourceColumns))
          : 1;
        const defaultVal = funcExpr.args.length > 2
          ? this.evaluateExpression(funcExpr.args[2], sourceRows[rowIdx], sourceColumns)
          : null;
        const lagIdx = posInPartition - offset;
        if (lagIdx < 0) return defaultVal;
        const lagRowIdx = partitionIndices[lagIdx];
        return this.evaluateExpression(funcExpr.args[0], sourceRows[lagRowIdx], sourceColumns);
      }

      case 'LEAD': {
        const offset = funcExpr.args.length > 1
          ? Number(this.evaluateExpression(funcExpr.args[1], sourceRows[rowIdx], sourceColumns))
          : 1;
        const defaultVal = funcExpr.args.length > 2
          ? this.evaluateExpression(funcExpr.args[2], sourceRows[rowIdx], sourceColumns)
          : null;
        const leadIdx = posInPartition + offset;
        if (leadIdx >= partitionIndices.length) return defaultVal;
        const leadRowIdx = partitionIndices[leadIdx];
        return this.evaluateExpression(funcExpr.args[0], sourceRows[leadRowIdx], sourceColumns);
      }

      case 'FIRST_VALUE': {
        const frameIndices = this.resolveFrameIndices(windowSpec, partitionIndices, posInPartition);
        if (frameIndices.length === 0) return null;
        return this.evaluateExpression(funcExpr.args[0], sourceRows[frameIndices[0]], sourceColumns);
      }

      case 'LAST_VALUE': {
        const frameIndices = this.resolveFrameIndices(windowSpec, partitionIndices, posInPartition);
        if (frameIndices.length === 0) return null;
        return this.evaluateExpression(funcExpr.args[0], sourceRows[frameIndices[frameIndices.length - 1]], sourceColumns);
      }

      case 'NTH_VALUE': {
        const n = funcExpr.args.length > 1
          ? Number(this.evaluateExpression(funcExpr.args[1], sourceRows[rowIdx], sourceColumns))
          : 1;
        const frameIndices = this.resolveFrameIndices(windowSpec, partitionIndices, posInPartition);
        if (n < 1 || n > frameIndices.length) return null;
        return this.evaluateExpression(funcExpr.args[0], sourceRows[frameIndices[n - 1]], sourceColumns);
      }

      // Aggregate window functions: SUM, COUNT, AVG, MIN, MAX with OVER
      case 'COUNT': case 'SUM': case 'AVG': case 'MIN': case 'MAX': {
        const frameIndices = this.resolveFrameIndices(windowSpec, partitionIndices, posInPartition);

        if (funcName === 'COUNT') {
          if (funcExpr.args.length === 0 || (funcExpr.args[0] && funcExpr.args[0].type === 'Star')) {
            return frameIndices.length;
          }
          let count = 0;
          for (const idx of frameIndices) {
            if (this.evaluateExpression(funcExpr.args[0], sourceRows[idx], sourceColumns) != null) count++;
          }
          return count;
        }

        const vals: number[] = [];
        for (const idx of frameIndices) {
          const v = this.evaluateExpression(funcExpr.args[0], sourceRows[idx], sourceColumns);
          if (v != null) vals.push(Number(v));
        }
        if (vals.length === 0) return null;

        switch (funcName) {
          case 'SUM': return vals.reduce((a, b) => a + b, 0);
          case 'AVG': return vals.reduce((a, b) => a + b, 0) / vals.length;
          case 'MIN': return Math.min(...vals);
          case 'MAX': return Math.max(...vals);
        }
        return null;
      }

      default:
        return null;
    }
  }

  private windowRowsEqual(
    windowSpec: import('../engine/parser/ASTNode').WindowSpec,
    rowA: StorageRow,
    rowB: StorageRow,
    columns: StorageColMeta[]
  ): boolean {
    if (!windowSpec.orderBy) return true;
    for (const ob of windowSpec.orderBy) {
      const va = this.evaluateExpression(ob.expr, rowA, columns);
      const vb = this.evaluateExpression(ob.expr, rowB, columns);
      if (this.compareValues(va, vb) !== 0) return false;
    }
    return true;
  }

  private resolveFrameIndices(
    windowSpec: import('../engine/parser/ASTNode').WindowSpec,
    partitionIndices: number[],
    posInPartition: number
  ): number[] {
    const frame = windowSpec.frame;
    if (!frame) {
      // Default frame: if ORDER BY present, UNBOUNDED PRECEDING to CURRENT ROW; else whole partition
      const hasOrderBy = windowSpec.orderBy && windowSpec.orderBy.length > 0;
      const end = hasOrderBy ? posInPartition : partitionIndices.length - 1;
      return partitionIndices.slice(0, end + 1);
    }
    const resolveBound = (bound: import('../engine/parser/ASTNode').FrameBound): number => {
      switch (bound.type) {
        case 'UNBOUNDED_PRECEDING': return 0;
        case 'UNBOUNDED_FOLLOWING': return partitionIndices.length - 1;
        case 'CURRENT_ROW': return posInPartition;
        case 'PRECEDING': {
          const n = bound.value ? Number(this.evaluateExpression(bound.value, [], [])) : 1;
          return Math.max(0, posInPartition - n);
        }
        case 'FOLLOWING': {
          const n = bound.value ? Number(this.evaluateExpression(bound.value, [], [])) : 1;
          return Math.min(partitionIndices.length - 1, posInPartition + n);
        }
      }
    };
    const start = resolveBound(frame.start);
    const end = frame.end ? resolveBound(frame.end) : posInPartition; // single bound defaults end to CURRENT ROW
    if (start > end) return [];
    return partitionIndices.slice(start, end + 1);
  }

  private evaluateExpressionGrouped(expr: Expression, groupRows: StorageRow[], columns: StorageColMeta[]): CellValue {
    if (expr.type === 'FunctionCall') {
      const name = expr.name.toUpperCase();
      if (['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'MEDIAN', 'STDDEV', 'VARIANCE', 'LISTAGG'].includes(name)) {
        return this.evaluateAggregate(name, expr, groupRows, columns);
      }
      // Non-aggregate function: evaluate using first row
      return this.evaluateExpression(expr, groupRows[0] || [], columns);
    }
    if (expr.type === 'BinaryExpr') {
      const left = this.evaluateExpressionGrouped(expr.left, groupRows, columns);
      const right = this.evaluateExpressionGrouped(expr.right, groupRows, columns);
      return this.applyBinaryOp(expr.operator, left, right);
    }
    // Non-aggregate column — use first row in group
    return this.evaluateExpression(expr, groupRows[0] || [], columns);
  }

  private evaluateAggregate(name: string, expr: FunctionCallExpr, groupRows: StorageRow[], columns: StorageColMeta[]): CellValue {
    if (name === 'COUNT') {
      if (expr.args.length === 0 || (expr.args[0] && expr.args[0].type === 'Star')) {
        return groupRows.length;
      }
      if (expr.distinct) {
        const unique = new Set<string>();
        for (const row of groupRows) {
          const val = this.evaluateExpression(expr.args[0], row, columns);
          if (val != null) unique.add(JSON.stringify(val));
        }
        return unique.size;
      }
      let count = 0;
      for (const row of groupRows) {
        if (this.evaluateExpression(expr.args[0], row, columns) != null) count++;
      }
      return count;
    }

    // Collect non-null values
    const values: number[] = [];
    for (const row of groupRows) {
      const val = this.evaluateExpression(expr.args[0], row, columns);
      if (val != null) values.push(Number(val));
    }

    if (values.length === 0) return null;

    switch (name) {
      case 'SUM': return values.reduce((a, b) => a + b, 0);
      case 'AVG': return values.reduce((a, b) => a + b, 0) / values.length;
      case 'MIN': {
        // Support string comparison
        const allVals = groupRows
          .map(row => this.evaluateExpression(expr.args[0], row, columns))
          .filter(v => v != null);
        return allVals.reduce((a, b) => this.compareValues(a, b) <= 0 ? a : b);
      }
      case 'MAX': {
        const allVals = groupRows
          .map(row => this.evaluateExpression(expr.args[0], row, columns))
          .filter(v => v != null);
        return allVals.reduce((a, b) => this.compareValues(a, b) >= 0 ? a : b);
      }
      case 'MEDIAN': {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
      }
      case 'STDDEV': {
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / (values.length - 1);
        return values.length === 1 ? 0 : Math.sqrt(variance);
      }
      case 'VARIANCE': {
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        return values.length === 1 ? 0 : values.reduce((s, v) => s + (v - avg) ** 2, 0) / (values.length - 1);
      }
      case 'LISTAGG': {
        // LISTAGG(expr, delimiter) — collect string values
        const strVals: string[] = [];
        for (const row of groupRows) {
          const val = this.evaluateExpression(expr.args[0], row, columns);
          if (val != null) strVals.push(String(val));
        }
        const delimiter = expr.args.length > 1
          ? String(this.evaluateExpression(expr.args[1], groupRows[0], columns) ?? ',')
          : '';
        return strVals.join(delimiter);
      }
      default: return null;
    }
  }

  private evaluateConditionAggregate(expr: Expression, groupRows: StorageRow[], columns: StorageColMeta[]): boolean {
    if (expr.type === 'BinaryExpr') {
      if (expr.operator === 'AND') {
        return this.evaluateConditionAggregate(expr.left, groupRows, columns)
          && this.evaluateConditionAggregate(expr.right, groupRows, columns);
      }
      if (expr.operator === 'OR') {
        return this.evaluateConditionAggregate(expr.left, groupRows, columns)
          || this.evaluateConditionAggregate(expr.right, groupRows, columns);
      }
      const left = this.evaluateExpressionGrouped(expr.left, groupRows, columns);
      const right = this.evaluateExpressionGrouped(expr.right, groupRows, columns);
      return this.applyComparison(expr.operator, left, right);
    }
    return !!this.evaluateExpressionGrouped(expr, groupRows, columns);
  }

  private resolveOrderByIndex(
    expr: Expression,
    selectCols: { name: string; alias?: string; colIndex: number; expr?: Expression }[],
    sourceCols: StorageColMeta[]
  ): number {
    // By column position number
    if (expr.type === 'Literal' && expr.dataType === 'number') {
      return Number(expr.value) - 1;
    }
    // By name/alias
    if (expr.type === 'Identifier') {
      const name = expr.name.toUpperCase();
      const idx = selectCols.findIndex(c => (c.alias || c.name).toUpperCase() === name || c.name.toUpperCase() === name);
      if (idx >= 0) return idx;
    }
    return -1;
  }

  private resolveOrderByIndexGrouped(
    expr: Expression,
    selectItems: SelectItem[],
    sourceCols: StorageColMeta[]
  ): number {
    if (expr.type === 'Literal' && expr.dataType === 'number') {
      return Number(expr.value) - 1;
    }
    if (expr.type === 'Identifier') {
      const name = expr.name.toUpperCase();
      const idx = selectItems.findIndex(item => {
        if (item.alias && item.alias.toUpperCase() === name) return true;
        if (item.expr.type === 'Identifier' && item.expr.name.toUpperCase() === name) return true;
        return false;
      });
      if (idx >= 0) return idx;
    }
    return -1;
  }

  // ── Set Operations ─────────────────────────────────────────────

  private executeSetOperation(stmt: SelectStatement): ResultSet {
    // Execute left side (without the setOp)
    const leftStmt: SelectStatement = { ...stmt, setOp: undefined };
    const leftResult = this.executeSelect(leftStmt);

    // Execute right side
    const rightResult = this.executeSelect(stmt.setOp!.right);

    const op = stmt.setOp!.op;

    if (op === 'UNION_ALL') {
      return queryResult(leftResult.columns, [...leftResult.rows, ...rightResult.rows]);
    }

    if (op === 'UNION') {
      const combined = [...leftResult.rows, ...rightResult.rows];
      const seen = new Set<string>();
      const unique = combined.filter(row => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return queryResult(leftResult.columns, unique);
    }

    if (op === 'INTERSECT') {
      const rightKeys = new Set(rightResult.rows.map(r => JSON.stringify(r)));
      const seen = new Set<string>();
      const intersection = leftResult.rows.filter(row => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        if (rightKeys.has(key)) { seen.add(key); return true; }
        return false;
      });
      return queryResult(leftResult.columns, intersection);
    }

    if (op === 'MINUS' || op === 'EXCEPT') {
      const rightKeys = new Set(rightResult.rows.map(r => JSON.stringify(r)));
      const seen = new Set<string>();
      const difference = leftResult.rows.filter(row => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        if (!rightKeys.has(key)) { seen.add(key); return true; }
        return false;
      });
      return queryResult(leftResult.columns, difference);
    }

    return leftResult;
  }

  // ── CONNECT BY (hierarchical queries) ────────────────────────────

  private executeConnectBy(rows: StorageRow[], columns: StorageColMeta[], connectBy: ConnectByClause): StorageRow[] {
    // Find root rows (matching START WITH if present)
    let rootRows: StorageRow[];
    if (connectBy.startWith) {
      rootRows = rows.filter(row => this.evaluateCondition(connectBy.startWith!, row, columns));
    } else {
      rootRows = [...rows];
    }

    const result: StorageRow[] = [];
    const visited = new Set<string>();

    const traverse = (parentRow: StorageRow, level: number) => {
      // Add LEVEL pseudo-column awareness
      const rowKey = JSON.stringify(parentRow);
      if (connectBy.noCycle && visited.has(rowKey)) return;
      if (level > 100) return; // Safety limit

      visited.add(rowKey);
      result.push(parentRow);

      // Find children by evaluating CONNECT BY condition with PRIOR
      for (const childRow of rows) {
        if (this.evaluateConnectByCondition(connectBy.condition, parentRow, childRow, columns)) {
          traverse(childRow, level + 1);
        }
      }

      visited.delete(rowKey);
    };

    for (const root of rootRows) {
      traverse(root, 1);
    }

    return result;
  }

  private evaluateConnectByCondition(
    expr: Expression, parentRow: StorageRow, childRow: StorageRow, columns: StorageColMeta[]
  ): boolean {
    // Handle PRIOR keyword: In CONNECT BY PRIOR x = y, PRIOR binds to the parent row
    if (expr.type === 'BinaryExpr') {
      if (expr.operator === 'AND') {
        return this.evaluateConnectByCondition(expr.left, parentRow, childRow, columns)
            && this.evaluateConnectByCondition(expr.right, parentRow, childRow, columns);
      }
      if (expr.operator === 'OR') {
        return this.evaluateConnectByCondition(expr.left, parentRow, childRow, columns)
            || this.evaluateConnectByCondition(expr.right, parentRow, childRow, columns);
      }

      // For comparison operators, resolve PRIOR references to parent row
      const left = this.evaluateConnectByExpr(expr.left, parentRow, childRow, columns);
      const right = this.evaluateConnectByExpr(expr.right, parentRow, childRow, columns);
      return this.applyComparison(expr.operator, left, right);
    }
    return this.evaluateCondition(expr, childRow, columns);
  }

  private evaluateConnectByExpr(
    expr: Expression, parentRow: StorageRow, childRow: StorageRow, columns: StorageColMeta[]
  ): CellValue {
    // PRIOR identifier → evaluate against parent row
    if (expr.type === 'UnaryExpr' && expr.operator === 'PRIOR') {
      return this.evaluateExpression(expr.operand, parentRow, columns);
    }
    // Regular expression → evaluate against child row
    return this.evaluateExpression(expr, childRow, columns);
  }

  // ── MERGE ──────────────────────────────────────────────────────────

  private executeMerge(stmt: MergeStatement): ResultSet {
    const targetSchema = (stmt.target.schema || this.context.currentSchema).toUpperCase();
    const targetName = stmt.target.name.toUpperCase();

    if (!this.storage.tableExists(targetSchema, targetName)) {
      throw new OracleError(942, `table or view does not exist`);
    }

    const targetMeta = this.storage.getTableMeta(targetSchema, targetName)!;

    // Load source data
    let sourceRows: StorageRow[];
    let sourceCols: StorageColMeta[];
    if (stmt.source.type === 'TableRef') {
      const loaded = this.loadTable(stmt.source);
      sourceRows = loaded.rows;
      sourceCols = loaded.columns;
    } else {
      // Subquery source
      const subResult = this.executeSelect(stmt.source.query);
      sourceRows = subResult.rows as StorageRow[];
      sourceCols = subResult.columns.map((c, i) => ({
        name: c.name, dataType: c.dataType, ordinalPosition: i,
      }));
    }

    let updatedCount = 0;
    let insertedCount = 0;
    const targetAlias = (stmt.target.alias || stmt.target.name).toUpperCase();
    const sourceAlias = (stmt.source.type === 'TableRef'
      ? (stmt.source.alias || stmt.source.name)
      : (stmt.source as { alias?: string }).alias || 'SOURCE').toUpperCase();
    const combinedCols = [
      ...targetMeta.columns.map((c, i) => ({
        ...c, ordinalPosition: i,
        _qualifiedNames: [`${targetAlias}.${c.name}`],
      })),
      ...sourceCols.map((c, i) => ({
        ...c, ordinalPosition: targetMeta.columns.length + i,
        _qualifiedNames: [`${sourceAlias}.${c.name}`],
      })),
    ];

    for (const srcRow of sourceRows) {
      // Find matching target rows
      const targetRows = this.storage.getRows(targetSchema, targetName);
      let matched = false;

      for (let tIdx = 0; tIdx < targetRows.length; tIdx++) {
        const combinedRow = [...targetRows[tIdx], ...srcRow] as StorageRow;
        if (this.evaluateCondition(stmt.on, combinedRow, combinedCols)) {
          matched = true;
          // WHEN MATCHED THEN UPDATE
          if (stmt.whenMatched) {
            const newRow = [...targetRows[tIdx]];
            for (const assign of stmt.whenMatched.assignments) {
              const colIdx = targetMeta.columns.findIndex(c => c.name.toUpperCase() === assign.column.toUpperCase());
              if (colIdx >= 0) {
                newRow[colIdx] = this.evaluateExpression(assign.value, combinedRow, combinedCols);
              }
            }
            this.storage.updateRows(targetSchema, targetName,
              (row) => JSON.stringify(row) === JSON.stringify(targetRows[tIdx]),
              () => newRow
            );
            updatedCount++;
          }
          break;
        }
      }

      if (!matched && stmt.whenNotMatched) {
        // WHEN NOT MATCHED THEN INSERT
        const newRow: StorageRow = new Array(targetMeta.columns.length).fill(null);
        const combinedRow = [...new Array(targetMeta.columns.length).fill(null), ...srcRow] as StorageRow;
        for (let i = 0; i < stmt.whenNotMatched.columns.length && i < stmt.whenNotMatched.values.length; i++) {
          const colIdx = targetMeta.columns.findIndex(c => c.name.toUpperCase() === stmt.whenNotMatched!.columns[i].toUpperCase());
          if (colIdx >= 0) {
            newRow[colIdx] = this.evaluateExpression(stmt.whenNotMatched.values[i], combinedRow, combinedCols);
          }
        }
        this.storage.insertRow(targetSchema, targetName, newRow);
        insertedCount++;
      }
    }

    const parts: string[] = [];
    if (updatedCount > 0) parts.push(`${updatedCount} row${updatedCount !== 1 ? 's' : ''} merged (updated)`);
    if (insertedCount > 0) parts.push(`${insertedCount} row${insertedCount !== 1 ? 's' : ''} merged (inserted)`);
    return emptyResult(parts.join(', ') || 'Merge complete.', updatedCount + insertedCount);
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

    // ORDER BY (before projection so we can reference original column positions)
    const colMetas: StorageColMeta[] = result.columns.map((c, i) => ({
      name: c.name, dataType: c.dataType, ordinalPosition: i,
    }));
    if (stmt.orderBy && stmt.orderBy.length > 0) {
      rows = [...rows];
      rows.sort((a, b) => {
        for (const ob of stmt.orderBy!) {
          const colIdx = this.resolveColumnIndex(ob.expr, colMetas);
          if (colIdx < 0) continue;
          let cmp = this.compareValues(a[colIdx], b[colIdx]);
          if (ob.direction === 'DESC') cmp = -cmp;
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    }

    // Column projection (SELECT col1, col2, ... or SELECT *)
    const isSelectAll = stmt.columns.length === 1 && stmt.columns[0].expr.type === 'Star';
    if (!isSelectAll) {
      const projectedCols: ColumnMeta[] = [];
      const colIndices: number[] = [];
      for (const selCol of stmt.columns) {
        if (selCol.expr.type === 'Identifier') {
          const colName = (selCol.expr as import('../engine/parser/ASTNode').IdentifierExpr).name.toUpperCase();
          const idx = colMetas.findIndex(c => c.name === colName);
          if (idx >= 0) {
            colIndices.push(idx);
            projectedCols.push({ name: selCol.alias?.toUpperCase() || colName, dataType: result.columns[idx].dataType });
          } else {
            // Column not found — add as null
            colIndices.push(-1);
            projectedCols.push({ name: selCol.alias?.toUpperCase() || colName, dataType: { type: 'VARCHAR2', length: 30 } });
          }
        } else {
          // Expression (function call, etc.) — evaluate at runtime
          colIndices.push(-2);
          const alias = selCol.alias?.toUpperCase() || (selCol.expr.type === 'Identifier' ? (selCol.expr as any).name.toUpperCase() : 'EXPR');
          projectedCols.push({ name: alias, dataType: { type: 'VARCHAR2', length: 4000 } });
        }
      }
      rows = rows.map(row => colIndices.map((idx, i) => {
        if (idx >= 0) return row[idx];
        if (idx === -2) {
          return this.evaluateExpression(stmt.columns[i].expr, row as StorageRow, colMetas);
        }
        return null;
      }));
      return { ...result, columns: projectedCols, rows };
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

    // CREATE TABLE AS SELECT (CTAS)
    if (stmt.asSelect) {
      const selectResult = this.executeSelect(stmt.asSelect);
      const columns: StorageColMeta[] = selectResult.columns.map((col, i) => ({
        name: col.name,
        dataType: col.dataType,
        ordinalPosition: i,
      }));
      this.storage.ensureSchema(schema);
      this.storage.createTable({
        schema, name: tableName, columns, constraints: [],
        tablespace: stmt.tablespace?.toUpperCase() || 'USERS',
        temporary: stmt.temporary,
        rowCount: 0,
      });
      for (const row of selectResult.rows) {
        this.storage.insertRow(schema, tableName, row as StorageRow);
      }
      return emptyResult('Table created.');
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
      } else if (action.action === 'MODIFY_COLUMN') {
        const col = action.column;
        const meta = this.storage.getTableMeta(schema, tableName);
        if (!meta) throw new OracleError(942, `table or view does not exist`);
        const existing = meta.columns.find(c => c.name === col.name.toUpperCase());
        if (!existing) throw new OracleError(904, `"${col.name.toUpperCase()}": invalid identifier`);
        // Update data type
        existing.dataType = parseOracleType(col.dataType.name, col.dataType.precision, col.dataType.scale);
        // Apply NOT NULL from constraints
        for (const cc of col.constraints) {
          if (cc.constraintType === 'NOT_NULL') {
            existing.dataType = { ...existing.dataType, nullable: false };
          }
        }
      } else if (action.action === 'DROP_COLUMN') {
        this.storage.dropColumn(schema, tableName, action.columnName.toUpperCase());
      }
    }

    return emptyResult('Table altered.');
  }

  private executeCreateIndex(stmt: CreateIndexStatement): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    const expressions = stmt.columns.map(c => c.expression ? c.expression.toUpperCase() : null);
    const hasExpressions = expressions.some(e => e !== null);
    this.storage.createIndex(schema, {
      name: stmt.name.toUpperCase(),
      tableName: stmt.table.toUpperCase(),
      columns: stmt.columns.map(c => c.name.toUpperCase()),
      unique: !!stmt.unique,
      bitmap: stmt.bitmap,
      ...(hasExpressions ? { expressions } : {}),
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

  // ── View DDL ─────────────────────────────────────────────────────

  private executeCreateView(stmt: CreateViewStatement): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    const name = stmt.name.toUpperCase();
    // For OR REPLACE, drop existing view first
    if (stmt.orReplace && this.storage.viewExists(schema, name)) {
      this.storage.dropView(schema, name);
    }
    // Reconstruct the query text from the AST by re-serializing the SELECT
    // We store the original query text for DBA_VIEWS
    const queryText = this.serializeSelect(stmt.query);
    this.storage.createView({
      schema, name,
      columns: stmt.columns,
      queryText,
      queryAST: stmt.query,
      withCheckOption: stmt.withCheckOption,
      withReadOnly: stmt.withReadOnly,
    });
    return emptyResult('View created.');
  }

  private executeDropView(stmt: DropViewStatement): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    this.storage.dropView(schema, stmt.name.toUpperCase());
    return emptyResult('View dropped.');
  }

  private serializeSelect(stmt: SelectStatement): string {
    // Minimal serialization for view storage — enough to re-parse later
    const parts: string[] = ['SELECT'];
    if (stmt.distinct) parts.push('DISTINCT');
    parts.push(stmt.columns.map(c => {
      const exprStr = this.serializeExpr(c.expr);
      return c.alias ? `${exprStr} AS ${c.alias}` : exprStr;
    }).join(', '));
    if (stmt.from && stmt.from.length > 0) {
      parts.push('FROM');
      parts.push(stmt.from.map(f => {
        if (f.type === 'TableRef') {
          const ref = f.schema ? `${f.schema}.${f.name}` : f.name;
          return f.alias ? `${ref} ${f.alias}` : ref;
        }
        return '(subquery)';
      }).join(', '));
    }
    if (stmt.where) parts.push('WHERE', this.serializeExpr(stmt.where));
    return parts.join(' ');
  }

  private serializeExpr(expr: Expression): string {
    switch (expr.type) {
      case 'Identifier': return (expr as IdentifierExpr).qualifier
        ? `${(expr as IdentifierExpr).qualifier}.${(expr as IdentifierExpr).name}`
        : (expr as IdentifierExpr).name;
      case 'Literal': {
        const lit = expr as LiteralExpr;
        return typeof lit.value === 'string' ? `'${lit.value}'` : String(lit.value ?? 'NULL');
      }
      case 'Star': return '*';
      case 'BinaryExpr': {
        const bin = expr as BinaryExpr;
        return `${this.serializeExpr(bin.left)} ${bin.operator} ${this.serializeExpr(bin.right)}`;
      }
      case 'FunctionCall': {
        const fn = expr as FunctionCallExpr;
        return `${fn.name}(${fn.args.map(a => this.serializeExpr(a)).join(', ')})`;
      }
      default: return '?';
    }
  }

  // ── EXPLAIN PLAN ─────────────────────────────────────────────────

  private executeExplainPlan(stmt: ExplainPlanStatement): ResultSet {
    const innerStmt = stmt.statement;
    const plan: Array<{ id: number; operation: string; name: string; rows: number; bytes: number; cost: number }> = [];
    let nextId = 0;

    const addStep = (operation: string, name: string, rows: number, cost: number) => {
      plan.push({ id: nextId++, operation, name, rows, bytes: rows * 100, cost });
    };

    if (innerStmt.type === 'SelectStatement') {
      const select = innerStmt as SelectStatement;
      // Build a simulated execution plan
      if (select.from && select.from.length > 0) {
        const tableName = select.from[0].type === 'TableRef' ? select.from[0].name : 'SUBQUERY';
        const schema = (select.from[0].type === 'TableRef' ? select.from[0].schema : null) || this.context.currentSchema;

        // Estimate row count
        let estimatedRows = 1000;
        const meta = this.storage.getTableMeta(schema.toUpperCase(), tableName.toUpperCase());
        if (meta) estimatedRows = meta.rowCount || 1;

        addStep('SELECT STATEMENT', '', estimatedRows, estimatedRows);

        if (select.orderBy && select.orderBy.length > 0) {
          addStep('SORT ORDER BY', '', estimatedRows, estimatedRows + 1);
        }
        if (select.groupBy && select.groupBy.length > 0) {
          addStep('HASH GROUP BY', '', Math.ceil(estimatedRows / 10), Math.ceil(estimatedRows / 10));
        }
        if (select.where) {
          addStep('TABLE ACCESS FULL', tableName.toUpperCase(), estimatedRows, estimatedRows);
        } else {
          addStep('TABLE ACCESS FULL', tableName.toUpperCase(), estimatedRows, estimatedRows);
        }

        // Add JOIN steps
        if (select.joins) {
          for (const join of select.joins) {
            const rightTable = join.table.type === 'TableRef' ? join.table.name.toUpperCase() : 'SUBQUERY';
            addStep('HASH JOIN', '', estimatedRows * 2, estimatedRows * 2);
            addStep('TABLE ACCESS FULL', rightTable, estimatedRows, estimatedRows);
          }
        }
      }
    } else if (innerStmt.type === 'InsertStatement') {
      const ins = innerStmt as InsertStatement;
      const tName = ins.table.name.toUpperCase();
      addStep('INSERT STATEMENT', '', 1, 1);
      addStep('LOAD TABLE CONVENTIONAL', tName, 1, 1);
    } else if (innerStmt.type === 'UpdateStatement') {
      const upd = innerStmt as UpdateStatement;
      const tName = upd.table.name.toUpperCase();
      addStep('UPDATE STATEMENT', '', 1, 1);
      addStep('UPDATE', tName, 1, 1);
      addStep('TABLE ACCESS FULL', tName, 1, 1);
    } else if (innerStmt.type === 'DeleteStatement') {
      const del = innerStmt as DeleteStatement;
      const tName = del.table.name.toUpperCase();
      addStep('DELETE STATEMENT', '', 1, 1);
      addStep('DELETE', tName, 1, 1);
      addStep('TABLE ACCESS FULL', tName, 1, 1);
    }

    // Return as a result set mimicking DBMS_XPLAN.DISPLAY_CURSOR output
    const columns: ColumnMeta[] = [
      { name: 'ID', dataType: 'NUMBER' },
      { name: 'OPERATION', dataType: 'VARCHAR2' },
      { name: 'NAME', dataType: 'VARCHAR2' },
      { name: 'ROWS', dataType: 'NUMBER' },
      { name: 'BYTES', dataType: 'NUMBER' },
      { name: 'COST', dataType: 'NUMBER' },
    ];
    const rows: Row[] = plan.map(p => [p.id, p.operation, p.name, p.rows, p.bytes, p.cost]);

    return { columns, rows, rowCount: rows.length, message: 'Explained.' };
  }

  // ── Triggers ─────────────────────────────────────────────────────

  private executeCreateTrigger(stmt: CreateTriggerStatement): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    const name = stmt.name.toUpperCase();
    const tableSchema = (stmt.tableSchema || this.context.currentSchema).toUpperCase();

    if (stmt.orReplace) {
      try { this.storage.dropTrigger(schema, name); } catch { /* ignore if not exists */ }
    }

    this.storage.createTrigger({
      schema, name,
      timing: stmt.timing,
      events: stmt.events,
      tableName: stmt.tableName.toUpperCase(),
      tableSchema,
      forEachRow: stmt.forEachRow || false,
      whenCondition: stmt.whenCondition,
      body: stmt.body,
      enabled: true,
    });

    return emptyResult('Trigger created.');
  }

  private executeDropTrigger(stmt: DropTriggerStatement): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    this.storage.dropTrigger(schema, stmt.name.toUpperCase());
    return emptyResult('Trigger dropped.');
  }

  fireTriggers(schema: string, tableName: string, event: 'INSERT' | 'UPDATE' | 'DELETE', timing: 'BEFORE' | 'AFTER'): void {
    const triggers = this.storage.getTriggersForTable(schema, tableName);
    for (const trigger of triggers) {
      if (trigger.timing === timing && trigger.events.includes(event)) {
        // Execute the trigger body as a PL/SQL block if it contains executable SQL
        // For the simulator, we just log that the trigger fired
        // A full implementation would parse and execute the body
      }
    }
  }

  // ── SYNONYM ────────────────────────────────────────────────────────

  private executeCreateSynonym(stmt: any): ResultSet {
    const owner = stmt.isPublic ? 'PUBLIC' : (stmt.schema || this.context.currentSchema).toUpperCase();
    const targetSchema = (stmt.targetSchema || this.context.currentSchema).toUpperCase();
    this.storage.createSynonym({
      owner,
      name: stmt.name.toUpperCase(),
      tableOwner: targetSchema,
      tableName: stmt.targetName.toUpperCase(),
      isPublic: !!stmt.isPublic,
    });
    return emptyResult('Synonym created.');
  }

  private executeDropSynonym(stmt: any): ResultSet {
    const owner = stmt.isPublic ? 'PUBLIC' : (stmt.schema || this.context.currentSchema).toUpperCase();
    this.storage.dropSynonym(owner, stmt.name.toUpperCase());
    return emptyResult('Synonym dropped.');
  }

  // ── ALTER SEQUENCE ────────────────────────────────────────────────

  private executeAlterSequence(stmt: any): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    const seq = this.storage.getSequence(schema, stmt.name.toUpperCase());
    if (!seq) throw new OracleError(2289, `sequence ${stmt.name} does not exist`);
    if (stmt.incrementBy !== undefined) seq.incrementBy = stmt.incrementBy;
    if (stmt.minValue !== undefined) seq.minValue = stmt.minValue;
    if (stmt.maxValue !== undefined) seq.maxValue = stmt.maxValue;
    if (stmt.cache !== undefined) seq.cache = stmt.cache;
    if (stmt.cycle !== undefined) seq.cycle = stmt.cycle;
    return emptyResult('Sequence altered.');
  }

  // ── ALTER INDEX ───────────────────────────────────────────────────

  private executeAlterIndex(stmt: any): ResultSet {
    const schema = (stmt.schema || this.context.currentSchema).toUpperCase();
    if (stmt.action === 'REBUILD') {
      // In a simulator, REBUILD is a no-op (the index is already in memory)
      const indexes = this.storage.getIndexes(schema);
      const idx = indexes.find(i => i.name === stmt.name.toUpperCase());
      if (!idx) throw new OracleError(1418, `specified index does not exist`);
      return emptyResult('Index altered.');
    }
    if (stmt.action === 'RENAME' && stmt.newName) {
      // Rename index — for simplicity, return success
      return emptyResult('Index altered.');
    }
    throw new OracleError(900, `Unsupported ALTER INDEX action: ${stmt.action}`);
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
      this.instance.setParameter(stmt.parameter, stmt.value, stmt.scope as 'MEMORY' | 'SPFILE' | 'BOTH' | undefined);
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
        // DBMS_RANDOM.VALUE / DBMS_RANDOM.NORMAL (no-parens access)
        const pkgName = (expr as IdentifierExpr).table?.toUpperCase();
        if (pkgName === 'DBMS_RANDOM') {
          const fn = expr.name.toUpperCase();
          if (fn === 'VALUE') return Math.random();
          if (fn === 'NORMAL') {
            const u1 = Math.random(), u2 = Math.random();
            return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          }
        }
        // DBMS_UTILITY (no-parens access)
        if (pkgName === 'DBMS_UTILITY') {
          const fn = expr.name.toUpperCase();
          if (fn === 'GET_TIME') return Date.now() % 2147483647;
          if (fn === 'FORMAT_ERROR_BACKTRACE' || fn === 'FORMAT_ERROR_STACK') return '';
        }
        // DBMS_LOB (no-parens access)
        if (pkgName === 'DBMS_LOB') {
          const fn = expr.name.toUpperCase();
          if (fn === 'GETLENGTH') return null;
        }
        // Oracle pseudo-columns
        const name = expr.name.toUpperCase();
        if (name === 'SYSDATE' || name === 'CURRENT_DATE') return new Date().toISOString().slice(0, 19).replace('T', ' ');
        if (name === 'SYSTIMESTAMP' || name === 'CURRENT_TIMESTAMP') return new Date().toISOString();
        if (name === 'USER') return this.context.currentUser;
        if (name === 'ROWNUM') return this._currentRowNum || 1;
        return null;
      }

      case 'Star': return null;

      case 'BinaryExpr': {
        const left = this.evaluateExpression(expr.left, row, columns);
        const right = this.evaluateExpression(expr.right, row, columns);
        return this.applyBinaryOp(expr.operator, left, right);
      }

      case 'UnaryExpr': {
        if (expr.operator === 'EXISTS' || expr.operator === 'NOT EXISTS') {
          // EXISTS handled in evaluateCondition, return boolean-ish value here
          const subExpr = expr.operand;
          if (subExpr.type === 'SubqueryExpr') {
            const subResult = this.executeSubquery(subExpr.query, row, columns);
            const exists = subResult.rows.length > 0;
            return expr.operator === 'NOT EXISTS' ? !exists : exists;
          }
          return null;
        }
        const operand = this.evaluateExpression(expr.operand, row, columns);
        if (expr.operator === '-') return typeof operand === 'number' ? -operand : null;
        if (expr.operator === '+') return operand;
        if (expr.operator === 'NOT') return operand ? false : true;
        return null;
      }

      case 'SubqueryExpr': {
        // Scalar subquery — execute and return single value
        const subResult = this.executeSubquery(expr.query, row, columns);
        if (subResult.rows.length === 0) return null;
        return subResult.rows[0][0];
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
        if (expr.operator === 'EXISTS') {
          if (expr.operand.type === 'SubqueryExpr') {
            const subResult = this.executeSubquery((expr.operand as SubqueryExpr).query, row, columns);
            return subResult.rows.length > 0;
          }
          return false;
        }
        if (expr.operator === 'NOT EXISTS') {
          if (expr.operand.type === 'SubqueryExpr') {
            const subResult = this.executeSubquery((expr.operand as SubqueryExpr).query, row, columns);
            return subResult.rows.length === 0;
          }
          return true;
        }
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
        // Subquery IN — values is a SelectStatement
        const subStmt = expr.values as unknown as SelectStatement;
        const subResult = this.executeSubquery(subStmt, row, columns);
        const found = subResult.rows.some(r => this.compareValues(val, r[0]) === 0);
        return expr.negated ? !found : found;
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

  /**
   * Execute a subquery in the context of an outer row (for correlated subqueries).
   * Replaces references to outer table aliases with values from the current row.
   */
  private executeSubquery(subStmt: SelectStatement, outerRow: StorageRow, outerColumns: StorageColMeta[]): ResultSet {
    // Create a patched version that falls back to outer row for unresolved identifiers
    const origMethod = this.evaluateExpression;
    this.evaluateExpression = (expr: Expression, row: StorageRow, columns: StorageColMeta[]): CellValue => {
      if (expr.type === 'Identifier') {
        // First try resolving in inner columns
        const innerIdx = this.resolveColumnIndex(expr, columns);
        if (innerIdx >= 0 && innerIdx < row.length) {
          return row[innerIdx];
        }
        // Then try outer columns (correlated reference)
        const outerIdx = this.resolveColumnIndex(expr, outerColumns);
        if (outerIdx >= 0 && outerIdx < outerRow.length) {
          return outerRow[outerIdx];
        }
        // DBMS_RANDOM without parens
        if ((expr as IdentifierExpr).table?.toUpperCase() === 'DBMS_RANDOM') {
          const fn = (expr as IdentifierExpr).name.toUpperCase();
          if (fn === 'VALUE') return Math.random();
          if (fn === 'NORMAL') {
            const u1 = Math.random(), u2 = Math.random();
            return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          }
        }
        // Pseudo-columns
        const name = (expr as IdentifierExpr).name.toUpperCase();
        if (name === 'SYSDATE' || name === 'CURRENT_DATE') return new Date().toISOString().slice(0, 19).replace('T', ' ');
        if (name === 'SYSTIMESTAMP' || name === 'CURRENT_TIMESTAMP') return new Date().toISOString();
        if (name === 'USER') return this.context.currentUser;
        if (name === 'ROWNUM') return this._currentRowNum || 1;
        return null;
      }
      return origMethod.call(this, expr, row, columns);
    };

    try {
      return this.executeSelect(subStmt);
    } finally {
      this.evaluateExpression = origMethod;
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
      case 'SYS_CONTEXT': {
        const namespace = args[0] != null ? String(args[0]).toUpperCase() : '';
        const param = args[1] != null ? String(args[1]).toUpperCase() : '';
        if (namespace === 'USERENV') {
          switch (param) {
            case 'CURRENT_SCHEMA': return this.context.currentSchema;
            case 'CURRENT_USER': return this.context.currentUser;
            case 'SESSION_USER': return this.context.currentUser;
            default: return this.context.currentUser;
          }
        }
        return this.context.currentUser;
      }

      // DBMS_RANDOM package
      case 'VALUE': {
        if (expr.schema?.toUpperCase() === 'DBMS_RANDOM') {
          if (args.length === 0) return Math.random();
          if (args.length >= 2) {
            const low = Number(args[0]);
            const high = Number(args[1]);
            return low + Math.random() * (high - low);
          }
          return Math.random();
        }
        return null;
      }
      case 'STRING': {
        if (expr.schema?.toUpperCase() === 'DBMS_RANDOM') {
          const opt = args.length > 0 ? String(args[0]).toUpperCase() : 'U';
          const len = args.length > 1 ? Number(args[1]) : 20;
          let chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
          if (opt === 'L') chars = 'abcdefghijklmnopqrstuvwxyz';
          if (opt === 'A' || opt === 'X') chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
          if (opt === 'P') chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
          let result = '';
          for (let i = 0; i < len; i++) result += chars[Math.floor(Math.random() * chars.length)];
          return result;
        }
        return null;
      }
      case 'NORMAL': {
        if (expr.schema?.toUpperCase() === 'DBMS_RANDOM') {
          // Box-Muller transform for normal distribution
          const u1 = Math.random();
          const u2 = Math.random();
          return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        }
        return null;
      }

      // DBMS_LOCK.SLEEP (as function call — returns immediately in simulator)
      case 'SLEEP': {
        if (expr.schema?.toUpperCase() === 'DBMS_LOCK') return null;
        return null;
      }

      // DBMS_UTILITY functions
      case 'GET_TIME': {
        if (expr.schema?.toUpperCase() === 'DBMS_UTILITY') return Date.now() % 2147483647;
        return null;
      }
      case 'FORMAT_ERROR_BACKTRACE': {
        if (expr.schema?.toUpperCase() === 'DBMS_UTILITY') return '';
        return null;
      }
      case 'FORMAT_ERROR_STACK': {
        if (expr.schema?.toUpperCase() === 'DBMS_UTILITY') return '';
        return null;
      }

      // DBMS_METADATA.GET_DDL
      case 'GET_DDL': {
        if (expr.schema?.toUpperCase() === 'DBMS_METADATA') {
          return this.getMetadataDDL(args);
        }
        return null;
      }

      // DBMS_STATS procedures (as stubs)
      case 'GATHER_TABLE_STATS':
      case 'GATHER_SCHEMA_STATS': {
        if (expr.schema?.toUpperCase() === 'DBMS_STATS') return null;
        return null;
      }

      // DBMS_LOB functions
      case 'GETLENGTH': {
        if (expr.schema?.toUpperCase() === 'DBMS_LOB') {
          return args[0] != null ? String(args[0]).length : null;
        }
        return null;
      }

      // UTL_FILE stubs
      case 'FOPEN':
      case 'FCLOSE':
      case 'GET_LINE': {
        if (expr.schema?.toUpperCase() === 'UTL_FILE') return null;
        return null;
      }

      // COUNT(*) and other aggregates return a single value for a column evaluation context
      // Real aggregation is handled at the query level — here we just return the scalar value
      case 'COUNT': return args.length === 0 || (expr.args[0] && expr.args[0].type === 'Star') ? 1 : (args[0] != null ? 1 : 0);
      case 'SUM': case 'AVG': case 'MIN': case 'MAX': return args[0] ?? null;

      default: return null;
    }
  }

  private getMetadataDDL(args: CellValue[]): CellValue {
    if (args.length < 2) return null;
    const objectType = String(args[0]).toUpperCase();
    const objectName = String(args[1]).toUpperCase();
    const schema = args.length >= 3 && args[2] ? String(args[2]).toUpperCase() : this.context.currentSchema;

    switch (objectType) {
      case 'TABLE': {
        const meta = this.storage.getTableMeta(schema, objectName);
        if (!meta) return null;
        const cols = meta.columns.map(c => {
          let def = `  ${c.name} ${c.dataType.name}`;
          if (c.dataType.precision != null) {
            def += c.dataType.scale != null && c.dataType.scale > 0
              ? `(${c.dataType.precision},${c.dataType.scale})`
              : `(${c.dataType.precision})`;
          }
          if (!c.dataType.nullable) def += ' NOT NULL';
          return def;
        }).join(',\n');
        return `CREATE TABLE ${schema}.${objectName} (\n${cols}\n)`;
      }
      case 'INDEX': {
        const indexes = this.storage.getIndexes(schema);
        const idx = indexes.find(i => i.name === objectName);
        if (!idx) return null;
        return `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${schema}.${objectName} ON ${schema}.${idx.tableName} (${idx.columns.join(', ')})`;
      }
      case 'VIEW': {
        const viewMeta = this.storage.getViewMeta(schema, objectName);
        if (!viewMeta) return null;
        return `CREATE OR REPLACE VIEW ${schema}.${objectName} AS ${viewMeta.queryText}`;
      }
      case 'SEQUENCE': {
        const seq = this.storage.getSequence(schema, objectName);
        if (!seq) return null;
        return `CREATE SEQUENCE ${schema}.${objectName} START WITH ${seq.currentValue} INCREMENT BY ${seq.incrementBy} MINVALUE ${seq.minValue} MAXVALUE ${seq.maxValue}${seq.cache > 0 ? ` CACHE ${seq.cache}` : ' NOCACHE'}${seq.cycle ? ' CYCLE' : ' NOCYCLE'}`;
      }
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
      const table = expr.table?.toUpperCase();
      const qualified = table ? `${table}.${name}` : null;

      // Try qualified match first (e.g., E.DEPT_ID)
      if (qualified) {
        const idx = columns.findIndex(c => {
          const qNames = (c as StorageColMeta & { _qualifiedNames?: string[] })._qualifiedNames;
          if (qNames) return qNames.some(qn => qn.toUpperCase() === qualified);
          return false;
        });
        // If a table qualifier was given, only return qualified match (don't fall through to plain name)
        return idx;
      }

      // Try plain name match (no table qualifier)
      const idx = columns.findIndex(c => c.name === name);
      if (idx >= 0) return idx;

      // Try qualified names for unqualified reference
      return columns.findIndex(c => {
        const qNames = (c as StorageColMeta & { _qualifiedNames?: string[] })._qualifiedNames;
        if (qNames) return qNames.some(qn => qn.toUpperCase() === name);
        return false;
      });
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
    if (a === null) return 1;  // Oracle: NULLs sort last in ASC
    if (b === null) return -1;
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
        const colIdx = this.resolveColumnIndex(item.expr, columns);
        if (colIdx >= 0) {
          result.push({ name: columns[colIdx].name, alias: item.alias, colIndex: colIdx, dataType: columns[colIdx].dataType });
        } else {
          const name = item.expr.name.toUpperCase();
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

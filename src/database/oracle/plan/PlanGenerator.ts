/**
 * PlanGenerator — turns a parsed `Statement` AST into an
 * `ExecutionPlan` the way Oracle's CBO would.
 *
 * The simulator's planner is intentionally simple but realistic for
 * teaching: it picks an access path per table based on which columns
 * the WHERE clause references, joins via NESTED LOOPS when the
 * driving row count is < 1000 and HASH JOIN otherwise, adds
 * SORT ORDER BY / HASH GROUP BY when the SELECT carries them, and
 * estimates rows from the statistics manager (or table.rowCount as
 * a fall-back).
 *
 * The output is a flat plan list with parent/child relationships
 * encoded the same way V$SQL_PLAN does so DBMS_XPLAN can render it
 * unmodified.
 */

import type { Statement, SelectStatement, InsertStatement, UpdateStatement, DeleteStatement,
  TableRef, BinaryExpr, IdentifierExpr } from '../../engine/parser/ASTNode';
import type { OracleStorage } from '../OracleStorage';
import type { OracleInstance } from '../OracleInstance';
import { ExecutionPlan, PlanNode, type PlanOperation } from './ExecutionPlan';

/** Cost coefficients used to scale estimates — tuned to match what
 *  a small Oracle 19c database returns on similar queries. */
const COST_FULL_SCAN_PER_BLOCK = 1;
const COST_INDEX_RANGE_PER_ROW = 0.5;
const COST_INDEX_UNIQUE = 1;
const COST_NESTED_LOOP_OVERHEAD = 2;
const COST_HASH_JOIN_OVERHEAD = 4;
const BLOCKS_PER_ROW = 1 / 8;
const NESTED_LOOP_THRESHOLD_ROWS = 1000;

export class PlanGenerator {
  constructor(
    private readonly storage: OracleStorage,
    private readonly instance: OracleInstance,
  ) {}

  /** Build an execution plan for the given statement. */
  generate(stmt: Statement, sqlId: string, sqlText: string, defaultSchema: string): ExecutionPlan {
    let id = 0;
    const nodes: PlanNode[] = [];
    const add = (
      parentId: number | null, depth: number, op: PlanOperation, options: string,
      owner: string | null, name: string | null, type: string | null,
      cardinality: number, cost: number,
      access: string | null = null, filter: string | null = null,
    ): PlanNode => {
      const bytes = cardinality * 100;
      const cpu = Math.max(1, Math.round(cost * 1000));
      const node = new PlanNode(
        id++, parentId, parentId === null ? 0 : 1, depth, op, options,
        owner, name, type, Math.round(cost), cardinality, bytes,
        cpu, Math.round(cost), access, filter, null,
      );
      nodes.push(node);
      return node;
    };

    switch (stmt.type) {
      case 'SelectStatement': this.planSelect(stmt, defaultSchema, add); break;
      case 'InsertStatement': this.planInsert(stmt, defaultSchema, add); break;
      case 'UpdateStatement': this.planUpdate(stmt, defaultSchema, add); break;
      case 'DeleteStatement': this.planDelete(stmt, defaultSchema, add); break;
      default:
        add(null, 0, 'SELECT STATEMENT', '', null, null, null, 1, 1);
        break;
    }

    return new ExecutionPlan({ sqlId, sqlText, nodes });
  }

  // ── SELECT planning ─────────────────────────────────────────────

  private planSelect(s: SelectStatement, defaultSchema: string,
                     add: (parentId: number | null, depth: number, op: PlanOperation, options: string,
                           owner: string | null, name: string | null, type: string | null,
                           cardinality: number, cost: number, access?: string | null, filter?: string | null) => PlanNode): void {
    if (!s.from || s.from.length === 0) {
      // SELECT FROM DUAL
      const root = add(null, 0, 'SELECT STATEMENT', '', null, null, null, 1, 2);
      add(root.id, 1, 'FAST DUAL', '', 'SYS', 'DUAL', 'TABLE', 1, 2);
      return;
    }

    const baseRows = this.estimateRowsFor(s.from[0], defaultSchema);
    const finalRows = s.groupBy ? Math.max(1, Math.ceil(baseRows / 10)) : baseRows;
    const root = add(null, 0, 'SELECT STATEMENT', '', null, null, null, finalRows, finalRows);

    // Top-of-tree sort / aggregate operators.
    let parent = root.id;
    let depth = 1;
    if (s.orderBy && s.orderBy.length > 0) {
      const sortCost = baseRows * Math.max(1, Math.log2(baseRows));
      const node = add(parent, depth, 'SORT ORDER BY', '', null, null, null, finalRows, sortCost);
      parent = node.id; depth++;
    }
    if (s.groupBy && s.groupBy.length > 0) {
      const node = add(parent, depth, 'HASH GROUP BY', '', null, null, null, finalRows, baseRows);
      parent = node.id; depth++;
    }
    if (s.where) {
      const node = add(parent, depth, 'FILTER', '', null, null, null, finalRows, baseRows);
      parent = node.id; depth++;
    }

    // Build join shape with the driving table on the left.
    const tables: { tableRef: TableRef; rows: number }[] = [];
    for (const t of s.from) {
      if (t.type === 'TableRef') tables.push({ tableRef: t, rows: this.estimateRowsFor(t, defaultSchema) });
    }
    if (s.joins) {
      for (const j of s.joins) {
        if (j.table.type === 'TableRef') {
          tables.push({ tableRef: j.table, rows: this.estimateRowsFor(j.table, defaultSchema) });
        }
      }
    }
    // For a single table this is just a TABLE ACCESS FULL.
    if (tables.length === 1) {
      this.planTableAccess(tables[0].tableRef, tables[0].rows, parent, depth, defaultSchema, s.where, add);
      return;
    }

    // For 2+ tables, fold them left-to-right.
    let leftRows = tables[0].rows;
    let joinParent = parent;
    let joinDepth = depth;
    let lastDriver: PlanNode | null = null;
    for (let i = 1; i < tables.length; i++) {
      const right = tables[i];
      const useHash = leftRows >= NESTED_LOOP_THRESHOLD_ROWS;
      const joinOp: PlanOperation = useHash ? 'HASH JOIN' : 'NESTED LOOPS';
      const joinCost = leftRows + right.rows + (useHash ? COST_HASH_JOIN_OVERHEAD : COST_NESTED_LOOP_OVERHEAD);
      const joinRows = Math.min(leftRows, right.rows);
      const joinNode = add(joinParent, joinDepth, joinOp, '', null, null, null, joinRows, joinCost);
      // Left child = previous driver / first table.
      if (i === 1) {
        this.planTableAccess(tables[0].tableRef, tables[0].rows, joinNode.id, joinDepth + 1, defaultSchema, s.where, add);
      } else if (lastDriver) {
        // The previous driver becomes the left child implicitly via the
        // recorded parent_id; no extra row needed.
      }
      // Right child.
      this.planTableAccess(right.tableRef, right.rows, joinNode.id, joinDepth + 1, defaultSchema, s.where, add);
      lastDriver = joinNode;
      leftRows = joinRows;
      joinParent = joinNode.id;
      joinDepth++;
    }
  }

  private planTableAccess(
    t: TableRef, rows: number, parentId: number, depth: number, defaultSchema: string,
    where: SelectStatement['where'] | undefined,
    add: (parentId: number | null, depth: number, op: PlanOperation, options: string,
          owner: string | null, name: string | null, type: string | null,
          cardinality: number, cost: number, access?: string | null, filter?: string | null) => PlanNode,
  ): PlanNode {
    const schema = (t.schema ?? defaultSchema).toUpperCase();
    const name = t.name.toUpperCase();
    const indexUsed = where ? this.findIndexForPredicate(schema, name, where) : null;

    if (indexUsed) {
      const uniqueScan = indexUsed.unique && indexUsed.fullKeyEquality;
      const scanRows = uniqueScan ? 1 : rows;
      const idxCost = uniqueScan ? 1 : rows * COST_INDEX_RANGE_PER_ROW;
      const accessCost = Math.max(1, Math.round(scanRows * BLOCKS_PER_ROW));
      const access = add(parentId, depth, 'TABLE ACCESS', 'BY INDEX ROWID',
        schema, name, 'TABLE', scanRows, accessCost + idxCost);
      add(access.id, depth + 1, 'INDEX', uniqueScan ? 'UNIQUE SCAN' : 'RANGE SCAN',
        schema, indexUsed.name, 'INDEX', scanRows, idxCost,
        `${this.firstColumnOf(indexUsed.name, schema)} = ?`);
      return access;
    }
    const blocks = Math.max(1, Math.ceil(rows * BLOCKS_PER_ROW));
    return add(parentId, depth, 'TABLE ACCESS', 'FULL',
      schema, name, 'TABLE', rows, blocks * COST_FULL_SCAN_PER_BLOCK);
  }

  private planInsert(s: InsertStatement, defaultSchema: string,
                     add: (parentId: number | null, depth: number, op: PlanOperation, options: string,
                           owner: string | null, name: string | null, type: string | null,
                           cardinality: number, cost: number, access?: string | null, filter?: string | null) => PlanNode): void {
    const root = add(null, 0, 'INSERT STATEMENT', '', null, null, null, 1, 1);
    const schema = (s.table.schema ?? defaultSchema).toUpperCase();
    add(root.id, 1, 'LOAD TABLE CONVENTIONAL', '', schema, s.table.name.toUpperCase(), 'TABLE', 1, 1);
  }

  private planUpdate(s: UpdateStatement, defaultSchema: string,
                     add: (parentId: number | null, depth: number, op: PlanOperation, options: string,
                           owner: string | null, name: string | null, type: string | null,
                           cardinality: number, cost: number, access?: string | null, filter?: string | null) => PlanNode): void {
    const schema = (s.table.schema ?? defaultSchema).toUpperCase();
    const name = s.table.name.toUpperCase();
    const rows = this.estimateRowsFor(s.table, defaultSchema);
    const root = add(null, 0, 'UPDATE STATEMENT', '', null, null, null, rows, rows);
    const upd = add(root.id, 1, 'UPDATE', '', schema, name, 'TABLE', rows, rows);
    add(upd.id, 2, 'TABLE ACCESS', 'FULL', schema, name, 'TABLE', rows, Math.max(1, Math.round(rows * BLOCKS_PER_ROW)));
  }

  private planDelete(s: DeleteStatement, defaultSchema: string,
                     add: (parentId: number | null, depth: number, op: PlanOperation, options: string,
                           owner: string | null, name: string | null, type: string | null,
                           cardinality: number, cost: number, access?: string | null, filter?: string | null) => PlanNode): void {
    const schema = (s.table.schema ?? defaultSchema).toUpperCase();
    const name = s.table.name.toUpperCase();
    const rows = this.estimateRowsFor(s.table, defaultSchema);
    const root = add(null, 0, 'DELETE STATEMENT', '', null, null, null, rows, rows);
    const del = add(root.id, 1, 'DELETE', '', schema, name, 'TABLE', rows, rows);
    add(del.id, 2, 'TABLE ACCESS', 'FULL', schema, name, 'TABLE', rows, Math.max(1, Math.round(rows * BLOCKS_PER_ROW)));
  }

  // ── Estimation helpers ───────────────────────────────────────────

  private estimateRowsFor(t: TableRef, defaultSchema: string): number {
    if (t.type !== 'TableRef') return 1000;
    const schema = (t.schema ?? defaultSchema).toUpperCase();
    const name = t.name.toUpperCase();
    // Prefer the statistics manager when populated.
    const stats = this.instance.statistics?.getTableStats(schema, name);
    if (stats && stats.numRows > 0) return stats.numRows;
    const meta = this.storage.getTableMeta(schema, name);
    return meta?.rowCount && meta.rowCount > 0 ? meta.rowCount : 1000;
  }

  /** Find a single-column index whose first column appears in the WHERE
   *  predicate as `col = expr` or `col IN (…)`. */
  private findIndexForPredicate(
    schema: string, table: string, where: unknown,
  ): { name: string; unique: boolean; fullKeyEquality: boolean } | null {
    const cols = this.extractEqualityColumns(where);
    if (cols.length === 0) return null;
    let best: { name: string; unique: boolean; fullKeyEquality: boolean } | null = null;
    for (const idx of this.storage.getIndexes(schema)) {
      if (idx.tableName.toUpperCase() !== table) continue;
      if (idx.columns.length === 0) continue;
      const first = idx.columns[0].toUpperCase();
      if (!cols.includes(first)) continue;
      const fullKeyEquality = idx.columns.every(c => cols.includes(c.toUpperCase()));
      const candidate = { name: idx.name, unique: idx.unique, fullKeyEquality };
      if (idx.unique && fullKeyEquality) return candidate;
      best = best ?? candidate;
    }
    return best;
  }

  private extractEqualityColumns(expr: unknown): string[] {
    if (!expr || typeof expr !== 'object') return [];
    const e = expr as { type?: string; operator?: string; left?: unknown; right?: unknown; name?: string };
    const out: string[] = [];
    // Recurse into AND / OR.
    if (e.operator === 'AND' || e.operator === 'OR') {
      out.push(...this.extractEqualityColumns(e.left));
      out.push(...this.extractEqualityColumns(e.right));
      return out;
    }
    // Equality / IN — left side identifier is the candidate index column.
    if (e.operator === '=' || e.operator === '==' || /^(IN|=)$/i.test(e.operator ?? '')) {
      const left = e.left as { type?: string; name?: string };
      if (left && typeof left.name === 'string') out.push(left.name.toUpperCase());
    }
    return out;
  }

  private firstColumnOf(indexName: string, schema: string): string {
    for (const idx of this.storage.getIndexes(schema)) {
      if (idx.name === indexName && idx.columns.length > 0) return idx.columns[0];
    }
    return '?';
  }
}

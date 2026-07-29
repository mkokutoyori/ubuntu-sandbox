/**
 * SelectColumnUsage — which columns a SELECT block actually touches.
 *
 * Column-level privileges are checked against every column a statement
 * reads, not just the projected ones: `SELECT salary FROM emp WHERE
 * id = 1` reads `id` too, and Oracle refuses it when only `salary` was
 * granted. The walk therefore covers the select list, WHERE, GROUP BY,
 * HAVING, ORDER BY and CONNECT BY.
 *
 * Nested SELECTs are deliberately left out: each one reaches the
 * executor on its own and is checked against its own FROM clause, so
 * folding their columns in here would attribute them to the wrong table.
 *
 * Only a `*` written as a select item stands for every column. The one
 * inside `COUNT(*)` reads no column in particular — it asks how many
 * rows there are, which the object-level privilege already answers.
 *
 * The caller resolves names to tables — this module only records how
 * each name was written.
 */

import type {
  Expression, SelectStatement, OrderByItem,
} from '../../engine/parser/ASTNode';

/** An unqualified `*`, which covers every table in the FROM clause. */
export const BARE_STAR = '*';

export interface SelectColumnUsage {
  /** Column names written with a table or alias qualifier, keyed by it. */
  qualified: Map<string, Set<string>>;
  /** Column names written bare; the owning table is resolved by the caller. */
  unqualified: Set<string>;
  /** Qualifiers a `*` appeared under, plus `BARE_STAR` for an unqualified one. */
  stars: Set<string>;
}

export function collectSelectColumnUsage(stmt: SelectStatement): SelectColumnUsage {
  const usage: SelectColumnUsage = {
    qualified: new Map(),
    unqualified: new Set(),
    stars: new Set(),
  };
  for (const item of stmt.columns) {
    if (item.expr.type === 'Star') {
      usage.stars.add((item.expr.table ?? BARE_STAR).toUpperCase());
      continue;
    }
    walk(item.expr, usage);
  }
  if (stmt.where) walk(stmt.where, usage);
  if (stmt.having) walk(stmt.having, usage);
  for (const expr of stmt.groupBy ?? []) walk(expr, usage);
  for (const item of (stmt.orderBy ?? []) as OrderByItem[]) walk(item.expr, usage);
  if (stmt.connectBy) {
    walk(stmt.connectBy.condition, usage);
    if (stmt.connectBy.startWith) walk(stmt.connectBy.startWith, usage);
  }
  return usage;
}

function record(usage: SelectColumnUsage, qualifier: string | undefined, name: string): void {
  const col = name.toUpperCase();
  if (!qualifier) { usage.unqualified.add(col); return; }
  const key = qualifier.toUpperCase();
  const bucket = usage.qualified.get(key) ?? new Set<string>();
  bucket.add(col);
  usage.qualified.set(key, bucket);
}

function walk(expr: Expression | undefined, usage: SelectColumnUsage): void {
  if (!expr || typeof expr !== 'object') return;
  const node = expr as Expression & Record<string, unknown>;
  switch (node.type) {
    case 'Identifier':
      record(usage, node.table as string | undefined, node.name as string);
      return;
    case 'Star':
      return;
    case 'SubqueryExpr':
      return;
    default:
      break;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) walkUnknown(item, usage);
    } else {
      walkUnknown(value, usage);
    }
  }
}

function walkUnknown(value: unknown, usage: SelectColumnUsage): void {
  if (!value || typeof value !== 'object') return;
  const node = value as { type?: unknown };
  if (typeof node.type !== 'string') return;
  if (node.type === 'SelectStatement') return;
  if (node.type === 'WindowSpec') {
    const spec = value as { partitionBy?: Expression[]; orderBy?: OrderByItem[] };
    for (const e of spec.partitionBy ?? []) walk(e, usage);
    for (const o of spec.orderBy ?? []) walk(o.expr, usage);
    return;
  }
  if (node.type === 'OrderByItem') {
    walk((value as OrderByItem).expr, usage);
    return;
  }
  if (node.type === 'WhenClause' || node.type === 'TypeSpec' || node.type === 'TableRef'
    || node.type === 'SubqueryTableRef' || node.type === 'JoinClause') {
    return;
  }
  walk(value as Expression, usage);
}

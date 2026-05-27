/**
 * ExecutionPlan — concrete representation of a SQL execution plan.
 *
 * Mirrors the structure of Oracle's `V$SQL_PLAN`: a flat ordered list
 * of `PlanNode` rows where parent/child relationships are encoded by
 * (id, parent_id, position, depth). Each node carries the cost and
 * cardinality estimates the optimizer would publish.
 *
 * Building a plan is the responsibility of `PlanGenerator`; this file
 * only models the result.
 */

export type PlanOperation =
  | 'SELECT STATEMENT' | 'INSERT STATEMENT' | 'UPDATE STATEMENT' | 'DELETE STATEMENT'
  | 'MERGE STATEMENT'
  | 'TABLE ACCESS' | 'INDEX' | 'INDEX UNIQUE SCAN' | 'INDEX RANGE SCAN'
  | 'INDEX FULL SCAN' | 'INDEX FAST FULL SCAN' | 'INDEX SKIP SCAN'
  | 'NESTED LOOPS' | 'HASH JOIN' | 'MERGE JOIN' | 'CARTESIAN'
  | 'SORT ORDER BY' | 'SORT AGGREGATE' | 'SORT GROUP BY' | 'SORT UNIQUE'
  | 'HASH GROUP BY' | 'HASH UNIQUE' | 'WINDOW SORT' | 'WINDOW BUFFER'
  | 'FILTER' | 'COUNT' | 'VIEW' | 'CONCATENATION' | 'UNION-ALL' | 'INTERSECTION'
  | 'CONNECT BY' | 'COLLECTION ITERATOR' | 'FAST DUAL'
  | 'LOAD TABLE CONVENTIONAL' | 'UPDATE' | 'DELETE';

/** Sub-classifier added to the OPERATION column by Oracle (TABLE
 *  ACCESS FULL, INDEX RANGE SCAN, etc.). */
export type AccessPath =
  | 'FULL' | 'BY INDEX ROWID' | 'BY USER ROWID' | 'BY ROWID RANGE'
  | 'CLUSTER' | 'BY GLOBAL INDEX ROWID' | 'BY LOCAL INDEX ROWID' | '';

export class PlanNode {
  constructor(
    readonly id: number,
    readonly parentId: number | null,
    readonly position: number,
    readonly depth: number,
    readonly operation: PlanOperation,
    readonly options: string,
    readonly objectOwner: string | null,
    readonly objectName: string | null,
    readonly objectType: string | null,
    readonly cost: number,
    readonly cardinality: number,
    readonly bytes: number,
    readonly cpuCost: number,
    readonly ioCost: number,
    readonly accessPredicates: string | null,
    readonly filterPredicates: string | null,
    readonly projection: string | null,
  ) {}

  /** DBA scripts that JOIN V$SQL_PLAN with V$SQL filter on object_alias.
   *  Real Oracle synthesises it from the table alias. */
  get objectAlias(): string | null {
    return this.objectName ? `${this.objectName}@SEL$1` : null;
  }
}

export class ExecutionPlan {
  /** Stable hash that V$SQL_PLAN populates as `PLAN_HASH_VALUE`. */
  readonly planHashValue: number;
  /** SQL_ID that produced this plan. */
  readonly sqlId: string;
  /** SQL text — repeated on the SELECT STATEMENT row by DBMS_XPLAN. */
  readonly sqlText: string;
  readonly nodes: PlanNode[];
  readonly createdAt: Date;

  constructor(init: {
    sqlId: string; sqlText: string; nodes: PlanNode[];
    planHashValue?: number; createdAt?: Date;
  }) {
    this.sqlId = init.sqlId;
    this.sqlText = init.sqlText;
    this.nodes = init.nodes;
    this.planHashValue = init.planHashValue ?? ExecutionPlan.hash(init.sqlText, init.nodes);
    this.createdAt = init.createdAt ?? new Date();
  }

  /** Total cost — sum of node costs, like Oracle's SELECT STATEMENT COST. */
  get totalCost(): number {
    return this.nodes.reduce((sum, n) => sum + n.cost, 0);
  }

  /** Combined cardinality estimate — root node value. */
  get totalRows(): number {
    return this.nodes[0]?.cardinality ?? 0;
  }

  /** Deterministic 31-bit hash for the plan, matching Oracle's PLAN_HASH_VALUE shape. */
  private static hash(sqlText: string, nodes: PlanNode[]): number {
    let h = 0;
    const seed = sqlText + '|' + nodes.map(n => `${n.operation}/${n.objectName ?? ''}`).join(';');
    for (let i = 0; i < seed.length; i++) {
      h = ((h << 5) - h + seed.charCodeAt(i)) & 0x7fffffff;
    }
    return h;
  }
}

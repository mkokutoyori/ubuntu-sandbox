/**
 * V$SQL_PLAN — execution plans for every cached SQL.
 *
 * Reads from `instance.planCache`, which the executor populates on
 * every parse via `PlanGenerator`. Schema matches Oracle 19c
 * V$SQL_PLAN; the JOIN to V$SQL through (SQL_ID, CHILD_NUMBER) works
 * as expected.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SQL_PLAN',
  comment: 'SQL execution plans',
  query({ instance }) {
    const rows: (string | number | null)[][] = [];
    for (const plan of instance.planCache.list()) {
      for (const n of plan.nodes) {
        rows.push([
          plan.sqlId, plan.planHashValue, 0,
          n.id, n.parentId, n.position, n.depth,
          n.operation, n.options,
          n.objectOwner, n.objectName, n.objectType,
          n.cost, n.cardinality, n.bytes,
          n.cpuCost, n.ioCost,
          n.accessPredicates, n.filterPredicates, n.projection,
          n.objectAlias,
        ]);
      }
    }
    return queryResult(
      [
        col.str('SQL_ID', 13),
        col.num('PLAN_HASH_VALUE'),
        col.num('CHILD_NUMBER'),
        col.num('ID'),
        col.num('PARENT_ID'),
        col.num('POSITION'),
        col.num('DEPTH'),
        col.str('OPERATION', 30),
        col.str('OPTIONS', 30),
        col.str('OBJECT_OWNER', 128),
        col.str('OBJECT_NAME', 128),
        col.str('OBJECT_TYPE', 30),
        col.num('COST'),
        col.num('CARDINALITY'),
        col.num('BYTES'),
        col.num('CPU_COST'),
        col.num('IO_COST'),
        col.str('ACCESS_PREDICATES', 4000),
        col.str('FILTER_PREDICATES', 4000),
        col.str('PROJECTION', 4000),
        col.str('OBJECT_ALIAS', 261),
      ],
      rows,
    );
  },
});

/**
 * V$SQL_SHARED_CURSOR — reasons a child cursor isn't sharable.
 *
 * Our SQL cache stores a single child per SQL_ID, so we emit one row
 * per cached cursor with all the "REASON" flags set to N — meaning the
 * cursor is fully sharable.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const REASON_COLUMNS = [
  'UNBOUND_CURSOR', 'SQL_TYPE_MISMATCH', 'OPTIMIZER_MISMATCH',
  'OUTLINE_MISMATCH', 'STATS_ROW_MISMATCH', 'LITERAL_MISMATCH',
  'FORCE_HARD_PARSE', 'EXPLAIN_PLAN_CURSOR', 'BUFFERED_DML_MISMATCH',
  'PDML_ENV_MISMATCH', 'INST_DRTLD_MISMATCH', 'SLAVE_QC_MISMATCH',
  'TYPECHECK_MISMATCH', 'AUTH_CHECK_MISMATCH', 'BIND_MISMATCH',
];

registerView({
  name: 'V$SQL_SHARED_CURSOR',
  comment: 'Cursor non-sharing reasons',
  query({ runtime }) {
    return queryResult(
      [
        col.str('SQL_ID', 13),
        col.num('ADDRESS'),
        col.num('CHILD_ADDRESS'),
        col.num('CHILD_NUMBER'),
        ...REASON_COLUMNS.map(name => col.str(name, 1)),
      ],
      [...runtime.sqlCache.values()].map(s => [
        s.sqlId, 0, 0, 0, ...REASON_COLUMNS.map(() => 'N'),
      ])
    );
  },
});

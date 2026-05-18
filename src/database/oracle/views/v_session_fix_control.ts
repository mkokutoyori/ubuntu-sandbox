/**
 * V$SESSION_FIX_CONTROL — bug fix controls visible in this session.
 *
 * Returns the (small) Oracle-internal _fix_control list. We surface a
 * representative subset.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const FIX_CONTROLS: Array<[number, string, string]> = [
  [4728348, 'OR-expansion: extra costing check', '11.2.0.4'],
  [5765456, 'Group-by elim transformation', '11.2.0.4'],
  [6440977, 'Subquery unnest with rollup', '11.2.0.4'],
  [12978495, 'Adaptive plan parallel server class', '12.1.0.1'],
  [13110511, 'Adaptive plans final state', '12.1.0.2'],
  [16515250, 'In-memory aggregation', '12.1.0.2'],
  [22386324, 'Inline hash join LOB', '12.2.0.1'],
];

registerView({
  name: 'V$SESSION_FIX_CONTROL',
  comment: 'Session-visible bug fix controls',
  query() {
    return queryResult(
      [
        col.num('BUGNO'),
        col.num('VALUE'),
        col.str('DESCRIPTION', 64),
        col.str('OPTIMIZER_FEATURE_ENABLE', 16),
        col.str('EVENT', 16),
        col.str('IS_DEFAULT', 3),
      ],
      FIX_CONTROLS.map(([bug, desc, ver]) => [bug, 1, desc, ver, '', 'YES'])
    );
  },
});

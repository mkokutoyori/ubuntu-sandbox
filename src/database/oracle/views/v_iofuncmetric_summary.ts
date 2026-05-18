/**
 * V$IOFUNCMETRIC_SUMMARY — hourly summary of V$IOFUNCMETRIC.
 */

import { queryView } from './registry';
import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$IOFUNCMETRIC_SUMMARY',
  comment: 'I/O function metric hourly summary',
  query(ctx) {
    const sample = queryView('V$IOFUNCMETRIC', ctx);
    if (!sample) return queryResult([], []);
    const end = Date.now();
    return queryResult(
      [
        col.date('BEGIN_TIME'),
        col.date('END_TIME'),
        col.str('FUNCTION_NAME', 32),
        col.num('MIN_VALUE'),
        col.num('MAX_VALUE'),
        col.num('AVERAGE'),
      ],
      sample.rows.map(r => {
        const val = (r[4] as number) ?? 0;
        return [
          new Date(end - 3600_000).toISOString(),
          new Date(end).toISOString(),
          r[3], val, val, val,
        ];
      })
    );
  },
});

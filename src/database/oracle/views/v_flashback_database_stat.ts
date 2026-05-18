/**
 * V$FLASHBACK_DATABASE_STAT — hourly flashback log size & redo size.
 *
 * Buckets `runtime.flashbackHistory` by hour. Each bucket reports the
 * sum of bytes logged during that hour as the FLASHBACK_DATA column.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$FLASHBACK_DATABASE_STAT',
  comment: 'Hourly flashback log statistics',
  query({ runtime }) {
    const buckets = new Map<number, number>();
    for (const f of runtime.flashbackHistory) {
      const hour = Math.floor(f.ts / 3_600_000);
      buckets.set(hour, (buckets.get(hour) ?? 0) + f.bytes);
    }
    return queryResult(
      [
        col.date('BEGIN_TIME'),
        col.date('END_TIME'),
        col.num('FLASHBACK_DATA'),
        col.num('DB_DATA'),
        col.num('REDO_DATA'),
        col.num('ESTIMATED_FLASHBACK_SIZE'),
      ],
      [...buckets.entries()].map(([hour, bytes]) => [
        new Date(hour * 3_600_000).toISOString(),
        new Date((hour + 1) * 3_600_000).toISOString(),
        bytes, bytes * 2, bytes / 2, bytes * 3,
      ])
    );
  },
});

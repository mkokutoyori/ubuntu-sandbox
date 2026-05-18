/**
 * V$FLASHBACK_DATABASE_LOG — flashback log space usage.
 *
 * Fed by `oracle.flashback.event` { kind: 'logged' }.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$FLASHBACK_DATABASE_LOG',
  comment: 'Flashback log usage',
  query({ runtime }) {
    const used = runtime.flashbackHistory.reduce((s, f) => s + f.bytes, 0);
    return queryResult(
      [
        col.num('OLDEST_FLASHBACK_SCN'),
        col.date('OLDEST_FLASHBACK_TIME'),
        col.num('RETENTION_TARGET'),
        col.num('FLASHBACK_SIZE'),
        col.num('ESTIMATED_FLASHBACK_SIZE'),
      ],
      [[
        runtime.flashbackHistory[0]?.scn ?? 0,
        runtime.flashbackHistory[0]
          ? new Date(runtime.flashbackHistory[0].ts).toISOString()
          : null as unknown as string,
        1440, used, used * 2,
      ]]
    );
  },
});

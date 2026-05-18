/**
 * V$ACTIVE_SERVICES — services currently advertised by this instance.
 *
 * Filters `OracleRuntimeState.services` on `active === true`. A service
 * becomes active on `oracle.service.event { kind: 'started' }` and is
 * deactivated by `{ kind: 'stopped' }`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$ACTIVE_SERVICES',
  comment: 'Active database services',
  query({ instance, runtime }) {
    const rows: (string | number)[][] = [];
    let idx = 1;
    for (const s of runtime.services.values()) {
      if (!s.active) continue;
      rows.push([
        idx++, s.name, s.name, instance.config.sid,
        new Date(s.startedAt).toISOString(),
      ]);
    }
    return queryResult(
      [
        col.num('SERVICE_ID'),
        col.str('NAME', 64),
        col.str('NETWORK_NAME', 64),
        col.str('SID', 30),
        col.str('CREATION_DATE', 20),
      ],
      rows
    );
  },
});

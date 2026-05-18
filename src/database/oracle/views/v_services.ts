/**
 * V$SERVICES — every service ever started against this instance.
 *
 * Backed by `OracleRuntimeState.services`, which the runtime actor
 * populates on every `oracle.service.event` (kind = 'started'). The
 * service stays in the map after stop — only V$ACTIVE_SERVICES filters
 * to active=true.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SERVICES',
  comment: 'Database services known to the instance',
  query({ runtime }) {
    return queryResult(
      [
        col.num('SERVICE_ID'),
        col.str('NAME', 64),
        col.str('NETWORK_NAME', 64),
        col.str('CREATION_DATE', 20),
        col.num('CREATION_DATE_HASH'),
      ],
      [...runtime.services.values()].map((s, idx) => [
        idx + 1, s.name, s.name, new Date(s.startedAt).toISOString(), s.startedAt | 0,
      ])
    );
  },
});

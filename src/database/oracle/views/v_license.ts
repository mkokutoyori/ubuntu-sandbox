/**
 * V$LICENSE — licensing high-water marks.
 *
 * In a real Oracle server this view is fed by the licensing component
 * that watches every logon: it tracks the current session count
 * (`SESSIONS_CURRENT`), its high-water mark (`SESSIONS_HIGHWATER`),
 * the configured limit and the cumulative session count.
 *
 * Reactive sourcing — we never invent rows. The values come from the
 * `OracleRuntimeState` whose actor increments `counters.logonsCumulative`
 * on every `oracle.session.connected` event. The current set of sessions
 * is the live `sessions` map, and the LICENSE_MAX_SESSIONS limit is read
 * from the instance parameter `sessions`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$LICENSE',
  comment: 'License limits and current/high-water session counts',
  query({ instance, runtime }) {
    const current = runtime.sessions.size;
    // The high-water mark is monotone non-decreasing: cumulative
    // connections is a safe upper bound when sessions never disconnect
    // in our simulator, otherwise we keep current as the floor.
    const highWater = Math.max(current, runtime.counters.logonsCumulative);
    const sessionsLimit = Number(instance.getParameter('sessions') ?? '0') || 0;
    const usersMax = Number(instance.getParameter('license_max_users') ?? '0') || 0;
    return queryResult(
      [
        col.num('SESSIONS_MAX'),
        col.num('SESSIONS_WARNING'),
        col.num('SESSIONS_CURRENT'),
        col.num('SESSIONS_HIGHWATER'),
        col.num('USERS_MAX'),
        col.num('CPU_COUNT_CURRENT'),
        col.num('CPU_CORE_COUNT_CURRENT'),
        col.num('CPU_SOCKET_COUNT_CURRENT'),
        col.num('CPU_COUNT_HIGHWATER'),
        col.num('CPU_CORE_COUNT_HIGHWATER'),
        col.num('CPU_SOCKET_COUNT_HIGHWATER'),
      ],
      [[sessionsLimit, 0, current, highWater, usersMax, 1, 1, 1, 1, 1, 1]]
    );
  },
});

/**
 * V$MYSTAT — per-statistic value for the *current* session.
 *
 * Reads the runtime counters and projects them as Oracle-canonical
 * statistic names. All values originate from event-driven counters
 * (commits, rollbacks, dml, parse, executions, …) so refreshing this
 * view is automatic on every relevant bus event.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { SYSSTAT_DEFINITIONS } from './v_statname';

registerView({
  name: 'V$MYSTAT',
  comment: 'Per-session statistics (current session)',
  query({ runtime, currentUser }) {
    const me = [...runtime.sessions.values()].find(s => s.schema === currentUser.toUpperCase());
    const sid = me?.sid ?? 1;
    return queryResult(
      [col.num('SID'), col.num('STATISTIC#'), col.num('VALUE')],
      SYSSTAT_DEFINITIONS.map((d, idx) => [sid, idx, d.value(runtime)])
    );
  },
});

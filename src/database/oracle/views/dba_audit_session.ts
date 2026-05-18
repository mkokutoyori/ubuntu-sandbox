/**
 * DBA_AUDIT_SESSION — logon/logoff audit entries.
 *
 * Derived from the runtime session table (oracle.session.connected /
 * disconnected). Each currently-known session produces a logon row.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_AUDIT_SESSION',
  comment: 'Session-level audit trail',
  query({ runtime }) {
    return queryResult(
      [
        col.str('OS_USERNAME', 30),
        col.str('USERNAME', 128),
        col.str('USERHOST', 128),
        col.str('TERMINAL', 128),
        col.date('TIMESTAMP'),
        col.str('ACTION_NAME', 28),
        col.num('SESSIONID'),
        col.num('LOGOFF_TIME'),
        col.num('RETURNCODE'),
      ],
      [...runtime.sessions.values()].map(s => [
        'oracle', s.username, 'localhost', 'pts/0',
        new Date(s.logonTime).toISOString(), 'LOGON', s.sid, 0, 0,
      ])
    );
  },
});

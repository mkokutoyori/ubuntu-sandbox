/**
 * V$SESSION_CONNECT_INFO — connection metadata per session.
 *
 * Reactively built from `runtime.sessions`, populated via
 * `oracle.session.connected`. Network properties are derived from the
 * runtime listener endpoint (also event-fed).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SESSION_CONNECT_INFO',
  comment: 'Network/auth info per session',
  query({ runtime }) {
    return queryResult(
      [
        col.num('SID'),
        col.num('SERIAL#'),
        col.str('AUTHENTICATION_TYPE', 26),
        col.str('OSUSER', 30),
        col.str('NETWORK_SERVICE_BANNER', 256),
        col.str('CLIENT_CHARSET', 30),
        col.str('CLIENT_CONNECTION', 12),
        col.str('CLIENT_OCI_LIBRARY', 30),
        col.str('CLIENT_VERSION', 30),
      ],
      [...runtime.sessions.values()].map(s => [
        s.sid, s.serial,
        s.username === 'SYS' ? 'OS' : 'DATABASE',
        'oracle',
        runtime.listenerEndpoint || 'TCP loopback',
        'AL32UTF8', 'Heterogeneous', 'Linux Userspace', '19.3.0.0.0',
      ])
    );
  },
});

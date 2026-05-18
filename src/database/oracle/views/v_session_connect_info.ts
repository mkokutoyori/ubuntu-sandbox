/**
 * V$SESSION_CONNECT_INFO — network/auth info per session.
 *
 * Sourced from the SecurityEngine session tracker (real sid/serial/
 * osuser) and the runtime listener endpoint for the network banner.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$SESSION_CONNECT_INFO',
  comment: 'Network/auth info per session',
  query({ catalog, runtime }) {
    const sessions = catalog.getSecurityEngine()?.sessions.getAllSessions() ?? [];
    return queryResult(
      [
        { name: 'SID', dataType: oracleNumber(10) },
        { name: 'SERIAL#', dataType: oracleNumber(10) },
        { name: 'AUTHENTICATION_TYPE', dataType: oracleVarchar2(26) },
        { name: 'OSUSER', dataType: oracleVarchar2(30) },
        { name: 'NETWORK_SERVICE_BANNER', dataType: oracleVarchar2(256) },
        { name: 'CLIENT_CHARSET', dataType: oracleVarchar2(30) },
        { name: 'CLIENT_CONNECTION', dataType: oracleVarchar2(12) },
        { name: 'CLIENT_OCI_LIBRARY', dataType: oracleVarchar2(30) },
        { name: 'CLIENT_VERSION', dataType: oracleVarchar2(30) },
      ],
      sessions.map(s => [
        s.sid, s.serial,
        s.username === 'SYS' ? 'OS' : 'DATABASE',
        s.osUser,
        runtime.listenerEndpoint || 'TCP loopback',
        'AL32UTF8', 'Heterogeneous', 'Linux Userspace', '19.3.0.0.0',
      ])
    );
  },
});

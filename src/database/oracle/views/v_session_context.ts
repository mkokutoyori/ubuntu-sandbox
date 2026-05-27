/**
 * V$SESSION_CONTEXT — values set by every application context in each
 * session. Native to Oracle 10g+; populated by DBMS_SESSION.SET_CONTEXT
 * and the implicit USERENV namespace.
 *
 * The simulator surfaces the USERENV namespace from each live
 * OracleSession; user-defined namespaces (registered via
 * DBMS_SESSION.SET_CONTEXT) will show up alongside when they are
 * implemented. Every row carries (NAMESPACE, ATTRIBUTE, VALUE).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const USERENV_ATTRS = [
  'SESSION_USER', 'CURRENT_USER', 'CURRENT_SCHEMA',
  'OS_USER', 'AUTHENTICATION_TYPE', 'AUTHENTICATION_METHOD',
  'AUTHENTICATED_IDENTITY', 'IDENTIFICATION_TYPE',
  'PROXY_USER', 'ISDBA',
  'HOST', 'IP_ADDRESS', 'TERMINAL', 'NETWORK_PROTOCOL',
  'DB_NAME', 'DB_UNIQUE_NAME', 'DB_DOMAIN',
  'INSTANCE', 'INSTANCE_NAME', 'SERVICE_NAME',
  'SESSIONID', 'MODULE', 'ACTION', 'CLIENT_INFO', 'CLIENT_IDENTIFIER',
  'CON_NAME', 'CON_ID',
];

registerView({
  name: 'V$SESSION_CONTEXT',
  comment: 'Application contexts (USERENV) per session',
  query({ catalog, instance }) {
    const engine = catalog.getSecurityEngine();
    const sessions = engine?.sessions.getAllSessions() ?? [];
    const liveSessions = instance.getLiveSessions();
    const liveBySid = new Map<number, typeof liveSessions[number]>();
    for (const ls of liveSessions) liveBySid.set(ls.sid, ls);
    const rows: (string | number | null)[][] = [];
    for (const s of sessions) {
      for (const attr of USERENV_ATTRS) {
        const value = resolveUserenv(s, attr, liveBySid.get(s.sid));
        if (value === null || value === undefined) continue;
        rows.push(['USERENV', attr, String(value), s.sid]);
      }
    }
    // User-defined contexts (set via DBMS_SESSION.SET_CONTEXT).
    for (const live of liveSessions) {
      for (const entry of live.listContextEntries()) {
        rows.push([entry.namespace, entry.attribute, entry.value, live.sid]);
      }
    }
    return queryResult(
      [
        col.str('NAMESPACE', 30),
        col.str('ATTRIBUTE', 128),
        col.str('VALUE', 4000),
        col.num('SID'),
      ],
      rows,
    );
  },
});

/** Cheap proxy resolver — view files cannot import OracleSession types. */
function resolveUserenv(
  s: import('../security/SessionLimitTracker').ActiveSessionInfo,
  attr: string,
  live?: { module: string | null; action: string | null;
           clientInfo: string | null; clientIdentifier: string | null },
): string | number | null {
  switch (attr) {
    case 'SESSION_USER':
    case 'CURRENT_USER':           return s.username;
    case 'CURRENT_SCHEMA':         return s.schema;
    case 'OS_USER':                return s.osUser;
    case 'HOST':                   return s.machine;
    case 'TERMINAL':               return s.terminal;
    case 'NETWORK_PROTOCOL':       return /@localhost$/i.test(s.program) ? 'beq' : 'tcp';
    case 'IP_ADDRESS':             return s.machine === 'localhost' ? '127.0.0.1' : '';
    case 'AUTHENTICATION_TYPE':    return 'DATABASE';
    case 'AUTHENTICATION_METHOD':  return 'PASSWORD';
    case 'AUTHENTICATED_IDENTITY': return s.username;
    case 'IDENTIFICATION_TYPE':    return 'LOCAL';
    case 'PROXY_USER':             return null;
    case 'ISDBA':                  return s.username === 'SYS' ? 'TRUE' : 'FALSE';
    case 'SERVICE_NAME':           return s.service;
    case 'SESSIONID':              return s.sid;
    case 'MODULE':                 return live?.module ?? s.module;
    case 'ACTION':                 return live?.action ?? s.action;
    case 'CLIENT_INFO':            return live?.clientInfo ?? s.clientInfo;
    case 'CLIENT_IDENTIFIER':      return live?.clientIdentifier ?? null;
    case 'CON_NAME':               return 'CDB$ROOT';
    case 'CON_ID':                 return 1;
    case 'DB_NAME':                return s.service;
    case 'DB_UNIQUE_NAME':         return s.service;
    case 'DB_DOMAIN':              return 'localdomain';
    case 'INSTANCE':               return 1;
    case 'INSTANCE_NAME':          return s.service;
    default:                       return null;
  }
}

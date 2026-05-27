/**
 * ALL_USERS — every database account, no admin privileges required.
 *
 * Native Oracle view. Distinct from DBA_USERS in that it carries
 * far fewer columns (USERNAME, USER_ID, CREATED, COMMON, ORACLE_MAINTAINED,
 * INHERITED, DEFAULT_COLLATION, IMPLICIT, ALL_SHARD, EXTERNAL_NAME).
 * Stays coherent with DBA_USERS by pulling the same source.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const ORACLE_MAINTAINED = new Set([
  'SYS', 'SYSTEM', 'PUBLIC', 'XDB', 'OUTLN', 'DBSNMP', 'APPQOSSYS',
  'GSMADMIN_INTERNAL', 'WMSYS', 'XS$NULL', 'ORACLE_OCM', 'CTXSYS',
  'ANONYMOUS', 'AUDSYS', 'DVSYS', 'DVF', 'LBACSYS', 'OJVMSYS',
  'OLAPSYS', 'ORDDATA', 'ORDPLUGINS', 'ORDSYS', 'SI_INFORMTN_SCHEMA',
  'SYSBACKUP', 'SYSDG', 'SYSKM', 'SYSRAC', 'MDSYS', 'EXFSYS',
]);

registerView({
  name: 'ALL_USERS',
  comment: 'Users visible to the current user',
  query({ catalog }) {
    return queryResult(
      [
        col.str('USERNAME', 128),
        col.num('USER_ID'),
        col.date('CREATED'),
        col.str('COMMON', 3),
        col.str('ORACLE_MAINTAINED', 1),
        col.str('INHERITED', 3),
        col.str('DEFAULT_COLLATION', 100),
        col.str('IMPLICIT', 3),
        col.str('ALL_SHARD', 3),
        col.str('EXTERNAL_NAME', 4000),
      ],
      catalog.getAllUsers().map(u => [
        u.username, u.userId, u.created.toISOString(),
        'NO',
        ORACLE_MAINTAINED.has(u.username) ? 'Y' : 'N',
        'NO', 'USING_NLS_COMP', 'NO', 'NO',
        u.externalName ?? null,
      ]),
    );
  },
});

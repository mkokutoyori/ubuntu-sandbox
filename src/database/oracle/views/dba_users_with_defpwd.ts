/**
 * DBA_USERS_WITH_DEFPWD — accounts whose password is a well-known
 * default. Native to Oracle 11g+ (the security guide recommends DBAs
 * scan this view weekly).
 *
 * The simulator compares each user's stored password against a
 * dictionary of well-known defaults; if it matches, the row appears.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

/** Canonical default passwords shipped by Oracle (CPU October 2012). */
const DEFAULT_PASSWORDS: Record<string, string> = {
  SYS: 'oracle', SYSTEM: 'oracle', DBSNMP: 'dbsnmp',
  SCOTT: 'tiger', HR: 'hr', OE: 'oe', SH: 'sh', IX: 'ix', PM: 'pm', BI: 'bi',
  OUTLN: 'outln', XDB: 'xdb', WMSYS: 'wmsys', ANONYMOUS: 'anonymous',
  CTXSYS: 'ctxsys', MDSYS: 'mdsys', OLAPSYS: 'olapsys',
  FCUBSLIVE: 'fcubs', APPQOSSYS: 'appqossys',
};

registerView({
  name: 'DBA_USERS_WITH_DEFPWD',
  comment: 'Accounts that still hold a well-known default password',
  query({ catalog }) {
    const rows: string[][] = [];
    for (const u of catalog.getAllUsers()) {
      const def = DEFAULT_PASSWORDS[u.username];
      if (!def) continue;
      const stored = catalog.getStoredPassword(u.username);
      if (stored && stored.toLowerCase() === def.toLowerCase()) {
        rows.push([u.username, 'YES']);
      }
    }
    return queryResult(
      [
        col.str('USERNAME', 128),
        col.str('PRODUCT', 30),
      ],
      rows,
    );
  },
});

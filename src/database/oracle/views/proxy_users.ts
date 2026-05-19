/**
 * PROXY_USERS — proxy-authentication relationships. Rows are produced
 * by `ALTER USER <client> GRANT CONNECT THROUGH <proxy>` statements,
 * which the catalog persists as a list of (client, proxy, role) tuples.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'PROXY_USERS',
  comment: 'Proxy authentication grants',
  query({ catalog }) {
    const c = catalog as unknown as {
      getProxyUsers?: () => { client: string; proxy: string; role: string | null }[];
    };
    const rows = c.getProxyUsers ? c.getProxyUsers() : [];
    return queryResult(
      [
        col.str('PROXY', 30),
        col.str('CLIENT', 30),
        col.str('AUTHENTICATION', 3),
        col.str('AUTHORIZATION_CONSTRAINT', 32),
        col.str('ROLE', 30),
      ],
      rows.map(r => [r.proxy, r.client, 'YES', r.role ? 'PROXY MAY ACTIVATE ROLE' : 'NO CLIENT ROLES MAY BE ACTIVATED', r.role ?? null])
    );
  },
});

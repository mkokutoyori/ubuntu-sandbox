/**
 * SESSION_PRIVS — system privileges effectively held by the current
 * session. Computed as the transitive closure of direct grants and
 * grants inherited through every enabled session role.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'SESSION_PRIVS',
  comment: 'System privileges available in the current session',
  query({ catalog, currentUser }) {
    const grants = catalog.getRoleGrants();
    const roleNames = new Set(catalog.getAllRoles().map(r => r.name.toUpperCase()));
    const enabled = new Set<string>([currentUser.toUpperCase()]);
    const queue: string[] = [currentUser.toUpperCase()];
    while (queue.length) {
      const grantee = queue.shift()!;
      for (const g of grants) {
        if (g.grantee.toUpperCase() !== grantee) continue;
        const role = g.role.toUpperCase();
        if (!roleNames.has(role) || enabled.has(role)) continue;
        enabled.add(role);
        queue.push(role);
      }
    }
    const sysGrants = catalog.getSysPrivilegeGrants();
    const privs = new Set<string>();
    for (const sp of sysGrants) {
      if (enabled.has(sp.grantee.toUpperCase())) privs.add(sp.privilege);
    }
    return queryResult(
      [{ name: 'PRIVILEGE', dataType: oracleVarchar2(40) }],
      [...privs].sort().map(p => [p]),
    );
  },
});

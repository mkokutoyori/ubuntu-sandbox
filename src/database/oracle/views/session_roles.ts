/**
 * SESSION_ROLES — roles currently enabled for the connected session.
 *
 * Real transitive closure over the catalog role-grant registry starting
 * from the session user: a role is enabled if granted to the user
 * directly or via another enabled role.
 *
 * `SET ROLE` narrows that closure — the walk starts from the roles the
 * session has actually enabled rather than from every granted one. This
 * is the only view that consults the session's enabled set; the
 * administration views report grants, which `SET ROLE` never changes.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'SESSION_ROLES',
  comment: 'Roles enabled in the current session',
  query({ catalog, currentUser, enabledRoles }) {
    const grants = catalog.getRoleGrants();
    const roleNames = new Set(catalog.getAllRoles().map(r => r.name.toUpperCase()));
    const enabled = new Set<string>();
    const queue: string[] = [currentUser.toUpperCase()];
    while (queue.length) {
      const grantee = queue.shift()!;
      for (const g of grants) {
        if (g.grantee.toUpperCase() !== grantee) continue;
        const role = g.role.toUpperCase();
        if (!roleNames.has(role) || enabled.has(role)) continue;
        if (grantee === currentUser.toUpperCase()
            && enabledRoles && !enabledRoles.has(role)) continue;
        enabled.add(role);
        queue.push(role); // walk nested role grants
      }
    }
    return queryResult(
      [{ name: 'ROLE', dataType: oracleVarchar2(128) }],
      [...enabled].map(r => [r])
    );
  },
});

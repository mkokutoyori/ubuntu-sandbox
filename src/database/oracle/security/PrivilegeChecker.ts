/**
 * PrivilegeChecker — Verify system and object privileges for a given user.
 *
 * Works with BaseCatalog's privilege collections to answer:
 *   - Does user X have system privilege P?
 *   - Does user X have object privilege P on schema.object?
 *   - Does role R expand to include privilege P?
 *
 * This is intentionally read-only: it only checks, never grants.
 */

import type { BaseCatalog, CatalogPrivilege } from '../../engine/catalog/BaseCatalog';

export class PrivilegeChecker {
  constructor(private readonly catalog: BaseCatalog) {}

  // ── System privilege checks ───────────────────────────────────────

  hasSystemPrivilege(username: string, privilege: string): boolean {
    const upper = username.toUpperCase();
    const priv = privilege.toUpperCase();
    return this.hasSystemPrivilegeDirect(upper, priv)
      || this.hasSystemPrivilegeViaRoles(upper, priv);
  }

  private hasSystemPrivilegeDirect(upper: string, priv: string): boolean {
    return (this.catalog as any).sysPrivileges.some(
      (p: CatalogPrivilege) => p.grantee === upper && p.privilege === priv
    );
  }

  private hasSystemPrivilegeViaRoles(upper: string, priv: string): boolean {
    const roles = this.getGrantedRoles(upper);
    for (const role of roles) {
      if (this.hasSystemPrivilegeDirect(role, priv)) return true;
    }
    return false;
  }

  /** Return all roles granted to a user (recursively, breadth-first). */
  getGrantedRoles(username: string): string[] {
    const visited = new Set<string>();
    const queue = [username.toUpperCase()];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const rg of (this.catalog as any).roleGrants as Array<{ grantee: string; role: string }>) {
        if (rg.grantee === current && !visited.has(rg.role)) {
          visited.add(rg.role);
          queue.push(rg.role);
        }
      }
    }
    return Array.from(visited);
  }

  // ── Object privilege checks ───────────────────────────────────────

  hasObjectPrivilege(
    username: string,
    privilege: string,
    objectSchema: string,
    objectName: string
  ): boolean {
    const upper = username.toUpperCase();
    const priv = privilege.toUpperCase();
    const schema = objectSchema.toUpperCase();
    const obj = objectName.toUpperCase();

    // Owner always has full access on own objects
    if (upper === schema) return true;

    // DBA role = all privileges
    if (this.hasSystemPrivilege(upper, 'DBA')) return true;

    // ANY privilege
    const anyPriv = `${priv} ANY TABLE`;
    if (this.hasSystemPrivilege(upper, anyPriv)) return true;

    // Direct grant OR object privilege inherited through any granted
    // role. DBA scripts routinely `GRANT SELECT ON x TO role` and rely
    // on the user picking it up transitively.
    const grantees = new Set<string>([upper, ...this.getGrantedRoles(upper), 'PUBLIC']);
    const cat = this.catalog as unknown as {
      tabPrivileges: CatalogPrivilege[];
      colPrivileges?: Array<{ grantee: string; privilege: string; objectSchema: string; objectName: string; columnName: string }>;
    };
    const tableMatch = cat.tabPrivileges.some(
      (p) =>
        grantees.has(p.grantee) &&
        p.privilege === priv &&
        p.objectSchema === schema &&
        p.objectName === obj
    );
    if (tableMatch) return true;
    // Column-level grants count too. They are restrictive (the executor
    // is responsible for refusing access to ungranted columns), but for
    // existence-vs-privilege disambiguation the user is considered to
    // have *some* access on the object.
    const colPrivs = cat.colPrivileges ?? [];
    return colPrivs.some(
      (p) =>
        grantees.has(p.grantee) &&
        p.privilege === priv &&
        p.objectSchema === schema &&
        p.objectName === obj
    );
  }

  // ── DBA check ────────────────────────────────────────────────────

  isDba(username: string): boolean {
    return this.hasSystemPrivilege(username, 'DBA')
      || this.getGrantedRoles(username).includes('DBA');
  }

  canGrantAny(username: string): boolean {
    return this.hasSystemPrivilege(username, 'GRANT ANY PRIVILEGE')
      || this.isDba(username);
  }

  canCreateUser(username: string): boolean {
    return this.hasSystemPrivilege(username, 'CREATE USER')
      || this.isDba(username);
  }

  canAlterUser(username: string): boolean {
    return this.hasSystemPrivilege(username, 'ALTER USER')
      || this.isDba(username);
  }

  canDropUser(username: string): boolean {
    return this.hasSystemPrivilege(username, 'DROP USER')
      || this.isDba(username);
  }

  canAlterSystem(username: string): boolean {
    return this.hasSystemPrivilege(username, 'ALTER SYSTEM')
      || this.isDba(username);
  }

  canSelectAnyTable(username: string): boolean {
    return this.hasSystemPrivilege(username, 'SELECT ANY TABLE')
      || this.isDba(username);
  }
}

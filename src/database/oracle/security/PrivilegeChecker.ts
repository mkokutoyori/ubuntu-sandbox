/**
 * PrivilegeChecker — Verify system and object privileges for a given user.
 *
 * Works with BaseCatalog's privilege collections to answer:
 *   - Does user X have system privilege P?
 *   - Does user X have object privilege P on schema.object?
 *   - Does role R expand to include privilege P?
 *
 * This is intentionally read-only: it only checks, never grants.
 *
 * Two questions live here and must not be confused (see
 * `docs/PRD-Oracle-Access-Management.md` §7.1):
 *   - « quels rôles cet utilisateur détient-il » — `getGrantedRoles()`,
 *     what the administration views report, unaffected by `SET ROLE`;
 *   - « quels rôles comptent maintenant » — `getEffectiveRoles()`, what
 *     authorization consults, narrowed by the session's enabled set.
 * Every privilege check below asks the second one.
 */

import type { BaseCatalog, CatalogPrivilege } from '../../engine/catalog/BaseCatalog';

/** The roles a session has enabled; `null` means "all granted ones". */
export type EnabledRoles = ReadonlySet<string> | null;

export class PrivilegeChecker {
  constructor(private readonly catalog: BaseCatalog) {}

  // ── System privilege checks ───────────────────────────────────────

  hasSystemPrivilege(username: string, privilege: string, enabled: EnabledRoles = null): boolean {
    const upper = username.toUpperCase();
    const priv = privilege.toUpperCase();
    return this.hasSystemPrivilegeDirect(upper, priv)
      || this.hasSystemPrivilegeViaRoles(upper, priv, enabled);
  }

  private hasSystemPrivilegeDirect(upper: string, priv: string): boolean {
    return this.catalog.getSysPrivilegeGrants().some(
      (p: CatalogPrivilege) => p.grantee === upper && p.privilege === priv
    );
  }

  private hasSystemPrivilegeViaRoles(upper: string, priv: string, enabled: EnabledRoles): boolean {
    const roles = this.getEffectiveRoles(upper, enabled);
    for (const role of roles) {
      if (this.hasSystemPrivilegeDirect(role, priv)) return true;
    }
    return false;
  }

  /**
   * Roles that carry privileges right now: the granted set, narrowed to
   * what the session has enabled. Enabling a role enables the roles it
   * itself holds, so the narrowing is applied at the top of the walk and
   * the closure is taken from there.
   */
  getEffectiveRoles(username: string, enabled: EnabledRoles): string[] {
    const granted = this.getGrantedRoles(username);
    if (enabled === null) return granted;
    const seeds = granted.filter(r => enabled.has(r));
    const visited = new Set<string>(seeds);
    const queue = [...seeds];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const rg of this.catalog.getRoleGrants()) {
        if (rg.grantee === current && !visited.has(rg.role)) {
          visited.add(rg.role);
          queue.push(rg.role);
        }
      }
    }
    return Array.from(visited);
  }

  /** Return all roles granted to a user (recursively, breadth-first). */
  getGrantedRoles(username: string): string[] {
    const visited = new Set<string>();
    const queue = [username.toUpperCase()];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const rg of this.catalog.getRoleGrants()) {
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
    objectName: string,
    enabled: EnabledRoles = null,
  ): boolean {
    const upper = username.toUpperCase();
    const priv = privilege.toUpperCase();
    const schema = objectSchema.toUpperCase();
    const obj = objectName.toUpperCase();

    // Owner always has full access on own objects
    if (upper === schema) return true;

    // DBA role = all privileges
    if (this.hasSystemPrivilege(upper, 'DBA', enabled)) return true;

    // ANY privilege
    const anyPriv = `${priv} ANY TABLE`;
    if (this.hasSystemPrivilege(upper, anyPriv, enabled)) return true;

    // Direct grant OR object privilege inherited through any granted
    // role. DBA scripts routinely `GRANT SELECT ON x TO role` and rely
    // on the user picking it up transitively.
    const grantees = new Set<string>([upper, ...this.getEffectiveRoles(upper, enabled), 'PUBLIC']);
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

  isDba(username: string, enabled: EnabledRoles = null): boolean {
    return this.hasSystemPrivilege(username, 'DBA', enabled)
      || this.getEffectiveRoles(username, enabled).includes('DBA');
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

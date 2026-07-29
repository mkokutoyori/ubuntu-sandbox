/**
 * BaseCatalog — Abstract system catalog (data dictionary) for a SQL database.
 *
 * Provides metadata about database objects (tables, views, users, privileges).
 * Subclasses implement dialect-specific catalog views (V$, DBA_, pg_catalog, etc.).
 */

import type { ResultSet } from '../executor/ResultSet';

export interface CatalogUser {
  username: string;
  userId: number;
  defaultTablespace: string;
  temporaryTablespace: string;
  accountStatus: 'OPEN' | 'LOCKED' | 'EXPIRED' | 'EXPIRED & LOCKED';
  lockDate: Date | null;
  expiryDate: Date | null;
  created: Date;
  profile: string;
  authenticationType: 'PASSWORD' | 'EXTERNAL' | 'GLOBAL';
  /** External principal (Kerberos SPN for EXTERNAL, distinguished name for GLOBAL). */
  externalName?: string;
}

export type RoleAuthenticationType = 'NONE' | 'PASSWORD' | 'EXTERNAL' | 'GLOBAL';

export interface CatalogRole {
  name: string;
  passwordRequired: boolean;
  authenticationType: RoleAuthenticationType;
}

export interface CatalogPrivilege {
  grantee: string;
  privilege: string;
  grantable: boolean;
  objectSchema?: string;
  objectName?: string;
  /**
   * Who handed this privilege over. Only object privileges need it —
   * revoking one cascades along the chain of grantors — but it is what
   * DBA_TAB_PRIVS.GRANTOR reports either way.
   */
  grantor?: string;
}

export abstract class BaseCatalog {
  protected users: Map<string, CatalogUser> = new Map();
  protected roles: Map<string, CatalogRole> = new Map();
  protected sysPrivileges: CatalogPrivilege[] = [];
  protected tabPrivileges: CatalogPrivilege[] = [];
  protected roleGrants: { grantee: string; role: string; adminOption: boolean }[] = [];

  /** Role grants (DBA_ROLE_PRIVS). */
  getRoleGrants(): ReadonlyArray<{ grantee: string; role: string; adminOption: boolean }> {
    return this.roleGrants;
  }

  /** System privilege grants (DBA_SYS_PRIVS). */
  getSysPrivilegeGrants(): ReadonlyArray<CatalogPrivilege> { return this.sysPrivileges; }

  // ── User management ──────────────────────────────────────────────

  createUser(user: CatalogUser): void {
    this.users.set(user.username.toUpperCase(), user);
  }

  dropUser(username: string): void {
    this.users.delete(username.toUpperCase());
  }

  getUser(username: string): CatalogUser | undefined {
    return this.users.get(username.toUpperCase());
  }

  userExists(username: string): boolean {
    return this.users.has(username.toUpperCase());
  }

  getAllUsers(): CatalogUser[] {
    return Array.from(this.users.values());
  }

  lockUser(username: string): void {
    const user = this.getUser(username);
    if (user) {
      user.accountStatus = 'LOCKED';
      user.lockDate = new Date();
    }
  }

  unlockUser(username: string): void {
    const user = this.getUser(username);
    if (user) {
      user.accountStatus = 'OPEN';
      user.lockDate = null;
    }
  }

  // ── Role management ──────────────────────────────────────────────

  createRole(name: string, authenticationType: RoleAuthenticationType = 'NONE'): void {
    const upper = name.toUpperCase();
    this.roles.set(upper, {
      name: upper,
      passwordRequired: authenticationType === 'PASSWORD',
      authenticationType,
    });
  }

  dropRole(name: string): void {
    const n = name.toUpperCase();
    this.roles.delete(n);
    this.roleGrants = this.roleGrants.filter(rg => rg.role !== n);
  }

  roleExists(name: string): boolean {
    return this.roles.has(name.toUpperCase());
  }

  getAllRoles(): CatalogRole[] {
    return Array.from(this.roles.values());
  }

  // ── Privilege management ─────────────────────────────────────────

  grantSystemPrivilege(grantee: string, privilege: string, grantable: boolean = false): void {
    const g = grantee.toUpperCase();
    const p = privilege.toUpperCase();
    const existing = this.sysPrivileges.find(x => x.grantee === g && x.privilege === p);
    if (existing) { if (grantable) existing.grantable = true; return; }
    this.sysPrivileges.push({ grantee: g, privilege: p, grantable });
  }

  revokeSystemPrivilege(grantee: string, privilege: string): void {
    this.sysPrivileges = this.sysPrivileges.filter(
      p => !(p.grantee === grantee.toUpperCase() && p.privilege === privilege.toUpperCase())
    );
  }

  grantTablePrivilege(grantee: string, privilege: string, objectSchema: string, objectName: string, grantable: boolean = false, grantor: string = 'SYS'): void {
    const g = grantee.toUpperCase();
    const p = privilege.toUpperCase();
    const sch = objectSchema.toUpperCase();
    const obj = objectName.toUpperCase();
    const gr = grantor.toUpperCase();
    // Keyed by grantor too, like real DBA_TAB_PRIVS: the same user can
    // hold one privilege from two people, and a revoke must be able to
    // pull one without the other.
    const existing = this.tabPrivileges.find(x =>
      x.grantee === g && x.privilege === p && x.objectSchema === sch && x.objectName === obj
      && (x.grantor ?? 'SYS') === gr);
    if (existing) {
      // Re-granting upgrades to WITH GRANT OPTION if asked.
      if (grantable) existing.grantable = true;
      return;
    }
    this.tabPrivileges.push({
      grantee: g, privilege: p, grantable, objectSchema: sch, objectName: obj, grantor: gr,
    });
  }

  /**
   * Revokes an object privilege and everything that hung from it.
   *
   * Oracle cascades an object-privilege revoke: whoever the revokee had
   * passed the privilege on to loses it in turn, down the whole chain.
   * A grant the same user also holds from someone else survives — only
   * the rows this revokee handed out are pulled.
   */
  revokeTablePrivilege(grantee: string, privilege: string, objectSchema: string, objectName: string): void {
    const p = privilege.toUpperCase();
    const sch = objectSchema.toUpperCase();
    const obj = objectName.toUpperCase();
    const onObject = (row: CatalogPrivilege): boolean =>
      row.privilege === p && row.objectSchema === sch && row.objectName === obj;

    const doomed = new Set<CatalogPrivilege>();
    const queue: string[] = [];
    for (const row of this.tabPrivileges) {
      if (onObject(row) && row.grantee === grantee.toUpperCase()) {
        doomed.add(row);
        queue.push(row.grantee);
      }
    }
    while (queue.length > 0) {
      const victim = queue.shift()!;
      // Someone who still holds the privilege from a surviving grant can
      // still have passed it on — their own grants stay.
      if (this.tabPrivileges.some(r => onObject(r) && r.grantee === victim && !doomed.has(r))) {
        continue;
      }
      for (const row of this.tabPrivileges) {
        if (onObject(row) && (row.grantor ?? 'SYS') === victim && !doomed.has(row)) {
          doomed.add(row);
          queue.push(row.grantee);
        }
      }
    }
    this.tabPrivileges = this.tabPrivileges.filter(row => !doomed.has(row));
  }

  grantRole(grantee: string, role: string, adminOption: boolean = false): void {
    const g = grantee.toUpperCase();
    const r = role.toUpperCase();
    const existing = this.roleGrants.find(rg => rg.grantee === g && rg.role === r);
    if (existing) {
      // Re-granting upgrades the admin-option flag — Oracle's behaviour.
      if (adminOption) existing.adminOption = true;
      return;
    }
    this.roleGrants.push({ grantee: g, role: r, adminOption });
  }

  revokeRole(grantee: string, role: string): void {
    this.roleGrants = this.roleGrants.filter(
      rg => !(rg.grantee === grantee.toUpperCase() && rg.role === role.toUpperCase())
    );
  }

  // ── REVOKE {GRANT|ADMIN} OPTION FOR — keep the grant, clear the option ──

  stripSystemGrantOption(grantee: string, privilege: string): void {
    const row = this.sysPrivileges.find(
      p => p.grantee === grantee.toUpperCase() && p.privilege === privilege.toUpperCase());
    if (row) row.grantable = false;
  }

  stripTableGrantOption(grantee: string, privilege: string, objectSchema: string, objectName: string): void {
    const row = this.tabPrivileges.find(
      p => p.grantee === grantee.toUpperCase() && p.privilege === privilege.toUpperCase()
        && p.objectSchema === objectSchema.toUpperCase() && p.objectName === objectName.toUpperCase());
    if (row) row.grantable = false;
  }

  stripRoleAdminOption(grantee: string, role: string): void {
    const row = this.roleGrants.find(
      rg => rg.grantee === grantee.toUpperCase() && rg.role === role.toUpperCase());
    if (row) row.adminOption = false;
  }

  hasSystemPrivilege(username: string, privilege: string): boolean {
    const u = username.toUpperCase();
    const p = privilege.toUpperCase();
    // Direct grant
    if (this.sysPrivileges.some(sp => sp.grantee === u && sp.privilege === p)) return true;
    // Via role
    for (const rg of this.roleGrants) {
      if (rg.grantee === u) {
        if (this.sysPrivileges.some(sp => sp.grantee === rg.role && sp.privilege === p)) return true;
      }
    }
    return false;
  }

  hasTablePrivilege(username: string, privilege: string, objectSchema: string, objectName: string): boolean {
    const u = username.toUpperCase();
    const p = privilege.toUpperCase();
    const os = objectSchema.toUpperCase();
    const on = objectName.toUpperCase();
    if (u === os) return true; // Owner has all privileges
    return this.tabPrivileges.some(tp =>
      tp.grantee === u && tp.privilege === p && tp.objectSchema === os && tp.objectName === on
    );
  }

  getUserRoles(username: string): string[] {
    return this.roleGrants.filter(rg => rg.grantee === username.toUpperCase()).map(rg => rg.role);
  }

  getUserPrivileges(username: string): CatalogPrivilege[] {
    return this.sysPrivileges.filter(p => p.grantee === username.toUpperCase());
  }

  // ── Catalog queries ──────────────────────────────────────────────

  /**
   * Execute a query against a system catalog view.
   * Returns null if the view name is not recognized.
   */
  abstract queryCatalogView(viewName: string, currentUser: string): ResultSet | null;
}

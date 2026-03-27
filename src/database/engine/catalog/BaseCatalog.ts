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
}

export interface CatalogRole {
  name: string;
  passwordRequired: boolean;
}

export interface CatalogPrivilege {
  grantee: string;
  privilege: string;
  grantable: boolean;
  objectSchema?: string;
  objectName?: string;
}

export abstract class BaseCatalog {
  protected users: Map<string, CatalogUser> = new Map();
  protected roles: Map<string, CatalogRole> = new Map();
  protected sysPrivileges: CatalogPrivilege[] = [];
  protected tabPrivileges: CatalogPrivilege[] = [];
  protected roleGrants: { grantee: string; role: string; adminOption: boolean }[] = [];

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

  createRole(name: string): void {
    this.roles.set(name.toUpperCase(), { name: name.toUpperCase(), passwordRequired: false });
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
    this.sysPrivileges.push({ grantee: grantee.toUpperCase(), privilege: privilege.toUpperCase(), grantable });
  }

  revokeSystemPrivilege(grantee: string, privilege: string): void {
    this.sysPrivileges = this.sysPrivileges.filter(
      p => !(p.grantee === grantee.toUpperCase() && p.privilege === privilege.toUpperCase())
    );
  }

  grantTablePrivilege(grantee: string, privilege: string, objectSchema: string, objectName: string, grantable: boolean = false): void {
    this.tabPrivileges.push({
      grantee: grantee.toUpperCase(),
      privilege: privilege.toUpperCase(),
      grantable,
      objectSchema: objectSchema.toUpperCase(),
      objectName: objectName.toUpperCase(),
    });
  }

  revokeTablePrivilege(grantee: string, privilege: string, objectSchema: string, objectName: string): void {
    this.tabPrivileges = this.tabPrivileges.filter(
      p => !(p.grantee === grantee.toUpperCase() && p.privilege === privilege.toUpperCase()
        && p.objectSchema === objectSchema.toUpperCase() && p.objectName === objectName.toUpperCase())
    );
  }

  grantRole(grantee: string, role: string, adminOption: boolean = false): void {
    this.roleGrants.push({ grantee: grantee.toUpperCase(), role: role.toUpperCase(), adminOption });
  }

  revokeRole(grantee: string, role: string): void {
    this.roleGrants = this.roleGrants.filter(
      rg => !(rg.grantee === grantee.toUpperCase() && rg.role === role.toUpperCase())
    );
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

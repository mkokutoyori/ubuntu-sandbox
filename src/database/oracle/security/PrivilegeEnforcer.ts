/**
 * PrivilegeEnforcer — centralized DCL/DDL/DML privilege checks for the SQL executor.
 *
 * Owns the Oracle error-code decision rules that were previously duplicated
 * between GRANT, REVOKE and the DML handlers in OracleExecutor:
 *  - ORA-01031 insufficient privileges
 *  - ORA-00942 table or view does not exist (information hiding: preferred
 *    over ORA-01031 when the user holds no privilege at all on the object)
 *  - ORA-01917 user or role does not exist (whole statement refused)
 *  - ORA-01934 circular role grant
 *
 * Reads the shared, mutable ExecutionContext so privilege checks always see
 * the session's current user, and the SecurityEngine through the catalog.
 */

import { OracleError } from '../../engine/types/DatabaseError';
import type { ExecutionContext } from '../../engine/executor/BaseExecutor';
import type { OracleCatalog } from '../OracleCatalog';

/** SYSOPER (PUBLIC schema) may only use instance-management privileges. */
const SYSOPER_ALLOWED_PRIVILEGES: ReadonlySet<string> = new Set([
  'ALTER SYSTEM', 'ALTER DATABASE', 'CREATE SESSION',
  'RESTRICTED SESSION', 'ALTER TABLESPACE',
]);

const OBJECT_PRIVILEGE_KINDS = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'ALTER', 'INDEX',
] as const;

export type DmlOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export class PrivilegeEnforcer {
  constructor(
    private readonly catalog: OracleCatalog,
    private readonly context: ExecutionContext,
  ) {}

  private get currentUser(): string { return this.context.currentUser; }

  /**
   * The roles the session has enabled, or `null` when every granted role
   * counts. Read from the live session so a `SET ROLE` issued mid-session
   * takes effect on the very next statement.
   */
  private get enabledRoles(): ReadonlySet<string> | null {
    const session = this.context.session as
      { getEnabledRoles?: () => ReadonlySet<string> | null } | undefined;
    return session?.getEnabledRoles?.() ?? null;
  }

  /** Throws ORA-01031 if the current user lacks every one of the listed system privileges. */
  requireSystemPrivilege(...privileges: string[]): void {
    const user = this.currentUser;
    if (user === 'SYS') return; // SYSDBA bypass
    if (user === 'PUBLIC') {
      for (const p of privileges) if (SYSOPER_ALLOWED_PRIVILEGES.has(p.toUpperCase())) return;
      throw new OracleError(1031, 'insufficient privileges');
    }
    const engine = this.catalog.getSecurityEngine();
    if (!engine) return;
    for (const p of privileges) {
      if (engine.privileges.hasSystemPrivilege(user, p, this.enabledRoles)) return;
    }
    throw new OracleError(1031, 'insufficient privileges');
  }

  /**
   * Throws ORA-01031 if the current user can neither (a) act on their own
   * schema, nor (b) hold an `ANY` system privilege for the operation on the
   * target schema. Used for cross-schema DDL such as `DROP TABLE other.t`.
   */
  requireSchemaOrAnyPrivilege(targetSchema: string, anyPrivilege: string): void {
    const user = this.currentUser;
    if (user === 'SYS') return;
    if (targetSchema.toUpperCase() === user) return; // own schema
    const engine = this.catalog.getSecurityEngine();
    if (!engine) return;
    if (!engine.privileges.hasSystemPrivilege(user, anyPrivilege, this.enabledRoles)) {
      throw new OracleError(1031, 'insufficient privileges');
    }
  }

  /**
   * Throws ORA-00942 when the user cannot see the cross-schema object —
   * Oracle prefers ORA-00942 over ORA-01031 when an object exists but the
   * user has no privilege at all on it (information hiding). When the user
   * holds some other privilege on the object, ORA-01031 is raised instead
   * (the user already knows the object exists).
   */
  requireObjectAccess(targetSchema: string, objectName: string, operation: DmlOperation): void {
    const user = this.currentUser;
    if (user === 'SYS') return;
    const targetUpper = targetSchema.toUpperCase();
    if (targetUpper === user) return;
    const engine = this.catalog.getSecurityEngine();
    if (!engine) return;
    const enabled = this.enabledRoles;
    if (engine.privileges.hasSystemPrivilege(user, `${operation} ANY TABLE`, enabled)) return;
    const objNameUpper = objectName.toUpperCase();
    if (engine.privileges.hasObjectPrivilege(user, operation, targetUpper, objNameUpper, enabled)) return;
    const hasAnyObjectPriv = OBJECT_PRIVILEGE_KINDS.some(op =>
      engine.privileges.hasObjectPrivilege(user, op, targetUpper, objNameUpper, enabled));
    if (hasAnyObjectPriv) throw new OracleError(1031, 'insufficient privileges');
    throw new OracleError(942, 'table or view does not exist');
  }

  /**
   * The columns the current user may touch for `operation` on the object,
   * or `null` when no column-level restriction applies. Callers use the
   * `null` answer to skip building a column list at all, so the ordinary
   * owner/DBA/table-privilege path stays exactly as cheap as before.
   */
  columnRestriction(
    targetSchema: string, objectName: string, operation: DmlOperation,
  ): ReadonlySet<string> | null {
    const user = this.currentUser;
    if (user === 'SYS') return null;
    const engine = this.catalog.getSecurityEngine();
    if (!engine) return null;
    return engine.privileges.getColumnRestriction(
      user, operation, targetSchema.toUpperCase(), objectName.toUpperCase(), this.enabledRoles);
  }

  /**
   * Throws ORA-01031 when the statement touches a column the current user
   * was not granted. A table-level grant covers every column, a column
   * grant only its own, and the two add up — so the whole check collapses
   * to "is every requested column inside the restriction set".
   *
   * Oracle refuses the statement as a whole: a single ungranted column in
   * an otherwise-permitted list is enough, and nothing is silently pruned.
   */
  requireColumnAccess(
    targetSchema: string, objectName: string, operation: DmlOperation, columns: Iterable<string>,
  ): void {
    const granted = this.columnRestriction(targetSchema, objectName, operation);
    if (granted === null) return;
    for (const col of columns) {
      if (!granted.has(col.toUpperCase())) {
        throw new OracleError(1031, 'insufficient privileges');
      }
    }
  }

  /**
   * Throws ORA-01917 if any grantee is neither a user nor a role — Oracle
   * refuses the entire GRANT/REVOKE statement before any mutation.
   */
  assertGranteesExist(grantees: string[]): void {
    for (const g of grantees) {
      const gUpper = g.toUpperCase();
      if (gUpper === 'PUBLIC') continue;
      if (!this.catalog.userExists(gUpper) && !this.catalog.roleExists(gUpper)) {
        throw new OracleError(1917, `user or role '${gUpper}' does not exist`);
      }
    }
  }

  /**
   * Throws ORA-01934 when granting `role` to `grantee` would create a cycle —
   * walks the role-grant transitive closure, matching real Oracle.
   */
  assertNoCircularRoleGrant(grantee: string, role: string): void {
    const granteeUpper = grantee.toUpperCase();
    const roleUpper = role.toUpperCase();
    if (granteeUpper === roleUpper) {
      throw new OracleError(1934, 'circular role grant detected');
    }
    const engine = this.catalog.getSecurityEngine();
    if (!engine) return;
    if (engine.privileges.getGrantedRoles(roleUpper).includes(granteeUpper)) {
      throw new OracleError(1934, 'circular role grant detected');
    }
  }

  /**
   * Throws ORA-01031 unless the current user may grant the listed object
   * privileges on `schema.objectName`: owner, SYS, DBA, or holder of every
   * privilege WITH GRANT OPTION.
   */
  requireGrantableObjectPrivileges(schema: string, objectName: string, privileges: string[]): void {
    const user = this.currentUser;
    if (user === 'SYS' || schema === user) return;
    const engine = this.catalog.getSecurityEngine();
    if (!engine || engine.privileges.isDba(user, this.enabledRoles)) return;
    const tabPrivs = this.catalog.getTablePrivilegeGrants();
    const holdsAllWithGrantOption = privileges.every(priv =>
      tabPrivs.some(p =>
        p.grantee === user
        && p.privilege === priv.toUpperCase()
        && p.objectSchema === schema
        && p.objectName === objectName
        && p.grantable === true));
    if (!holdsAllWithGrantOption) {
      throw new OracleError(1031, 'insufficient privileges');
    }
  }
}

/**
 * UserAdminExecutor — DCL handlers for the user/role/profile lifecycle.
 *
 * Extracted from the OracleExecutor god class (backlog O7). Owns:
 * CREATE/ALTER/DROP USER, CREATE/DROP ROLE, CREATE/ALTER/DROP PROFILE,
 * and the `oracle.user.activity` event emission tied to that lifecycle.
 *
 * Statement-level concerns (DDL implicit COMMIT, dispatch) stay in
 * OracleExecutor; this class only enforces Oracle semantics for its
 * statement family (ORA-01918/01920/01921/02379/02380/28003/28009…).
 */

import type { ExecutionContext } from '../../engine/executor/BaseExecutor';
import { type ResultSet, emptyResult } from '../../engine/executor/ResultSet';
import type {
  CreateUserStatement, AlterUserStatement, DropUserStatement,
  CreateRoleStatement, DropRoleStatement,
  CreateProfileStatement, AlterProfileStatement, DropProfileStatement,
} from '../../engine/parser/ASTNode';
import { OracleError } from '../../engine/types/DatabaseError';
import type { OracleStorage } from '../OracleStorage';
import type { OracleCatalog } from '../OracleCatalog';
import type { OracleInstance } from '../OracleInstance';
import type { PrivilegeEnforcer } from '../security/PrivilegeEnforcer';
import type { UserActivityKind } from '../events';

/** SYS-supplied schemas that can never be dropped (ORA-28009). */
const PROTECTED_SCHEMAS: ReadonlySet<string> = new Set([
  'SYS', 'SYSTEM', 'PUBLIC', 'XDB', 'OUTLN', 'AUDSYS', 'DBSNMP',
  'CTXSYS', 'MDSYS', 'WMSYS',
]);

export interface UserAdminDeps {
  storage: OracleStorage;
  catalog: OracleCatalog;
  instance: OracleInstance;
  context: ExecutionContext;
  privileges: PrivilegeEnforcer;
  /** Numeric session id of the executing SQL*Plus/database session. */
  getSessionId: () => number;
}

export class UserAdminExecutor {
  constructor(private readonly deps: UserAdminDeps) {}

  private get catalog(): OracleCatalog { return this.deps.catalog; }
  private get privileges(): PrivilegeEnforcer { return this.deps.privileges; }
  private get context(): ExecutionContext { return this.deps.context; }

  // ── Users ─────────────────────────────────────────────────────────

  executeCreateUser(stmt: CreateUserStatement): ResultSet {
    this.privileges.requireSystemPrivilege('CREATE USER');
    const catalog = this.catalog;
    if (catalog.userExists(stmt.username)) {
      throw new OracleError(1920, `user name '${stmt.username.toUpperCase()}' conflicts with another user or role name`);
    }
    const profileName = (stmt.profile || 'DEFAULT').toUpperCase();
    if (stmt.profile && !catalog.profileExists(profileName)) {
      throw new OracleError(2380, `profile ${profileName} does not exist`);
    }
    const username = stmt.username.toUpperCase();
    const authType = stmt.authenticationKind ?? (stmt.password ? 'PASSWORD' : 'PASSWORD');
    // Reject weak passwords up-front when the chosen profile carries a
    // PASSWORD_VERIFY_FUNCTION. Real Oracle calls the verifier before
    // creating the row, so the user is never persisted.
    if (authType === 'PASSWORD' && stmt.password) {
      const verifierError = catalog.getSecurityEngine()?.verifyPasswordForProfile(username, stmt.password, profileName);
      if (verifierError) throw new OracleError(28003, verifierError.replace(/^ORA-28003:\s*/, ''));
    }
    catalog.createUser({
      username,
      userId: catalog.allocateUserId(),
      defaultTablespace: stmt.defaultTablespace?.toUpperCase() || 'USERS',
      temporaryTablespace: stmt.temporaryTablespace?.toUpperCase() || 'TEMP',
      accountStatus: stmt.accountLocked ? 'LOCKED' : 'OPEN',
      lockDate: stmt.accountLocked ? new Date() : null,
      expiryDate: null,
      created: new Date(),
      profile: profileName,
      authenticationType: authType,
      externalName: stmt.externalName,
    });
    if (authType === 'PASSWORD' && stmt.password) {
      catalog.setPassword(username, stmt.password);
      catalog.getSecurityEngine()?.passwords.setPassword(username, stmt.password);
    }
    if ((authType === 'GLOBAL' || authType === 'EXTERNAL') && stmt.externalName) {
      catalog.setExternalName(username, stmt.externalName);
    }
    if (stmt.passwordExpired) {
      catalog.getSecurityEngine()?.passwords.expirePassword(username);
    }
    // Apply tablespace quotas
    if (stmt.quota && stmt.quota.length > 0) {
      catalog.getSecurityEngine()?.applyQuotas(username, stmt.quota);
    }
    this.deps.storage.ensureSchema(username);
    this.emitUserActivity(username, 'CREATED', { profile: profileName, authType });
    return emptyResult('User created.');
  }

  executeAlterUser(stmt: AlterUserStatement): ResultSet {
    const catalog = this.catalog;
    const username = stmt.username.toUpperCase();
    if (!catalog.userExists(username)) {
      // ALTER USER on a non-existent user is ORA-01918 (user does not
      // exist) — distinct from the generic ORA-01917 (user or role).
      throw new OracleError(1918, `user '${username}' does not exist`);
    }

    // Users may always alter their own password; any other ALTER USER needs ALTER USER priv.
    const isSelfPasswordChange =
      username === this.context.currentUser &&
      stmt.password !== undefined &&
      !stmt.accountLock && !stmt.accountUnlock && !stmt.passwordExpire &&
      !stmt.defaultTablespace && !stmt.temporaryTablespace &&
      !stmt.profile && (!stmt.quota || stmt.quota.length === 0);
    if (!isSelfPasswordChange) {
      this.privileges.requireSystemPrivilege('ALTER USER');
    }

    const engine = catalog.getSecurityEngine();
    const user = catalog.getUser(username);

    if (stmt.password) {
      const profileName = user?.profile ?? 'DEFAULT';
      // IDENTIFIED BY VALUES '<hash>' bypasses password verification —
      // the value is an opaque verifier already produced by Oracle.
      if (engine && !stmt.passwordByHash) {
        const result = engine.changePassword(username, stmt.password, profileName);
        if (!result.ok) throw new OracleError(28007, result.error ?? 'password reuse violation');
      }
      catalog.setPassword(username, stmt.password);
      if (user) {
        user.authenticationType = 'PASSWORD';
        user.externalName = undefined;
      }
      this.emitUserActivity(username, 'PASSWORD_CHANGED', { profile: profileName });
    } else if (stmt.authenticationKind && user) {
      user.authenticationType = stmt.authenticationKind;
      if (stmt.externalName !== undefined) {
        user.externalName = stmt.externalName;
        catalog.setExternalName(username, stmt.externalName);
      } else if (stmt.authenticationKind === 'EXTERNAL') {
        // Bare IDENTIFIED EXTERNALLY — clear any prior principal.
        user.externalName = undefined;
      }
    }
    if (stmt.accountLock) {
      catalog.lockUser(username);
      engine?.loginTracker.lockAccount(username);
      this.emitUserActivity(username, 'LOCKED', { by: 'ALTER USER' });
    }
    if (stmt.accountUnlock) {
      catalog.unlockUser(username);
      engine?.loginTracker.unlockAccount(username);
      this.emitUserActivity(username, 'UNLOCKED', { by: 'ALTER USER' });
    }
    if (stmt.passwordExpire) {
      engine?.passwords.expirePassword(username);
      this.emitUserActivity(username, 'PASSWORD_EXPIRED', {});
      // Do NOT set accountStatus here — dbaUsers() derives the combined status
      // from PasswordManager + lock state to handle EXPIRED & LOCKED correctly.
    }
    if (stmt.defaultTablespace && user) {
      user.defaultTablespace = stmt.defaultTablespace.toUpperCase();
    }
    if (stmt.temporaryTablespace && user) {
      user.temporaryTablespace = stmt.temporaryTablespace.toUpperCase();
    }
    if (stmt.profile) {
      const profileName = stmt.profile.toUpperCase();
      if (!catalog.profileExists(profileName)) {
        throw new OracleError(2380, `profile ${profileName} does not exist`);
      }
      if (user) user.profile = profileName;
    }
    if (stmt.quota && stmt.quota.length > 0) {
      engine?.applyQuotas(username, stmt.quota);
    }
    if (stmt.defaultRoleSpec) {
      catalog.setDefaultRoleSpec(username, stmt.defaultRoleSpec);
    }
    if (stmt.proxy) {
      const proxyName = stmt.proxy.proxy.toUpperCase();
      if (!catalog.userExists(proxyName)) {
        throw new OracleError(1917, `user or role '${proxyName}' does not exist`);
      }
      if (stmt.proxy.mode === 'GRANT') {
        catalog.grantProxy(username, proxyName, stmt.proxy.role);
      } else {
        catalog.revokeProxy(username, proxyName);
      }
    }
    return emptyResult('User altered.');
  }

  executeDropUser(stmt: DropUserStatement): ResultSet {
    this.privileges.requireSystemPrivilege('DROP USER');
    const catalog = this.catalog;
    const username = stmt.username.toUpperCase();
    if (PROTECTED_SCHEMAS.has(username)) {
      throw new OracleError(28009, `cannot drop user '${username}': protected schema`);
    }
    if (!catalog.userExists(username)) {
      throw new OracleError(1918, `user '${username}' does not exist`);
    }
    catalog.getSecurityEngine()?.dropUserCleanup(username);
    catalog.dropUser(username);
    this.emitUserActivity(username, 'DROPPED', {});
    return emptyResult('User dropped.');
  }

  // ── Roles ─────────────────────────────────────────────────────────

  executeCreateRole(stmt: CreateRoleStatement): ResultSet {
    this.privileges.requireSystemPrivilege('CREATE ROLE');
    const catalog = this.catalog;
    const upper = stmt.name.toUpperCase();
    if (catalog.roleExists(upper) || catalog.userExists(upper)) {
      throw new OracleError(1921, `role name '${upper}' conflicts with another user or role name`);
    }
    const authKind = stmt.authenticationKind ?? 'NONE';
    catalog.createRole(stmt.name, authKind);
    if (authKind === 'PASSWORD' && stmt.password) {
      catalog.setRolePassword(stmt.name, stmt.password);
    }
    return emptyResult('Role created.');
  }

  executeDropRole(stmt: DropRoleStatement): ResultSet {
    this.privileges.requireSystemPrivilege('DROP ANY ROLE');
    const catalog = this.catalog;
    if (!catalog.roleExists(stmt.name)) {
      throw new OracleError(1919, `role '${stmt.name.toUpperCase()}' does not exist`);
    }
    catalog.dropRole(stmt.name);
    return emptyResult('Role dropped.');
  }

  // ── Profiles ──────────────────────────────────────────────────────

  executeCreateProfile(stmt: CreateProfileStatement): ResultSet {
    this.privileges.requireSystemPrivilege('CREATE PROFILE');
    if (this.catalog.profileExists(stmt.profileName)) {
      throw new OracleError(2379, `profile ${stmt.profileName.toUpperCase()} already exists`);
    }
    this.catalog.createProfile(stmt.profileName, stmt.limits);
    return emptyResult('Profile created.');
  }

  executeAlterProfile(stmt: AlterProfileStatement): ResultSet {
    this.privileges.requireSystemPrivilege('ALTER PROFILE');
    if (!this.catalog.profileExists(stmt.profileName)) {
      throw new OracleError(2380, `profile ${stmt.profileName.toUpperCase()} does not exist`);
    }
    this.catalog.alterProfile(stmt.profileName, stmt.limits);
    return emptyResult('Profile altered.');
  }

  executeDropProfile(stmt: DropProfileStatement): ResultSet {
    this.privileges.requireSystemPrivilege('DROP PROFILE');
    if (!this.catalog.profileExists(stmt.profileName)) {
      throw new OracleError(2380, `profile ${stmt.profileName.toUpperCase()} does not exist`);
    }
    this.catalog.dropProfile(stmt.profileName);
    return emptyResult('Profile dropped.');
  }

  // ── Events ────────────────────────────────────────────────────────

  /** Publish an `oracle.user.activity` event onto the instance bus. */
  private emitUserActivity(
    username: string,
    kind: UserActivityKind,
    detail: Record<string, string | number | boolean>,
  ): void {
    const { instance } = this.deps;
    instance.getBus().publish({
      topic: 'oracle.user.activity',
      payload: {
        deviceId: instance.getDeviceId(), sid: instance.config.sid,
        username: username.toUpperCase(), kind,
        sessionId: this.deps.getSessionId(),
        performedBy: this.context.currentSchema,
        detail, timestamp: new Date(),
      },
    });
  }
}

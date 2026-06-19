/**
 * SecurityDclExecutor — DCL/security statement handlers.
 *
 * Extracted from the OracleExecutor god class (backlog O7). Owns:
 * GRANT / REVOKE (system privileges, roles, object and column grants),
 * AUDIT / NOAUDIT (traditional auditing), unified audit policies, TDE
 * key management (ADMINISTER KEY MANAGEMENT) and COMMENT ON.
 *
 * Enforces the real Oracle error ladder for this family:
 * ORA-00942/00904 (missing object/column), ORA-01749 (self grant),
 * ORA-01917 (bad grantee), ORA-01924/01927 (revoke without grant),
 * ORA-01931 (grant to SYS), ORA-46365 (missing audit policy),
 * ORA-46651 (keystore location required).
 */

import type { ExecutionContext } from '../../engine/executor/BaseExecutor';
import { type ResultSet, emptyResult } from '../../engine/executor/ResultSet';
import type {
  GrantStatement, RevokeStatement, AuditStatement, NoauditStatement,
  CreateAuditPolicyStatement, DropAuditPolicyStatement, AuditPolicyStatement,
  AdministerKeyManagementStatement, CommentStatement,
} from '../../engine/parser/ASTNode';
import { OracleError } from '../../engine/types/DatabaseError';
import type { OracleStorage } from '../OracleStorage';
import type { OracleCatalog } from '../OracleCatalog';
import type { PrivilegeEnforcer } from '../security/PrivilegeEnforcer';
import { ORACLE_SYSTEM_PRIVILEGES, isAdministrativePrivilege } from '../security/systemPrivileges';

export interface SecurityDclDeps {
  storage: OracleStorage;
  catalog: OracleCatalog;
  context: ExecutionContext;
  privileges: PrivilegeEnforcer;
}

export class SecurityDclExecutor {
  constructor(private readonly deps: SecurityDclDeps) {}

  private get catalog(): OracleCatalog { return this.deps.catalog; }
  private get storage(): OracleStorage { return this.deps.storage; }
  private get privileges(): PrivilegeEnforcer { return this.deps.privileges; }
  private get context(): ExecutionContext { return this.deps.context; }

  private resolveSchema(explicit?: string | null): string {
    return (explicit || this.context.currentSchema).toUpperCase();
  }

  // ── GRANT / REVOKE ────────────────────────────────────────────────

  private granteesOf(stmt: GrantStatement | RevokeStatement): string[] {
    return stmt.grantees && stmt.grantees.length > 0 ? stmt.grantees : [stmt.grantee];
  }

  /**
   * Expand the ALL PRIVILEGES shortcut into the full set of system
   * privileges, matching real Oracle's DBA_SYS_PRIVS expansion. Entries
   * keep whether they came from the shortcut (REVOKE must not raise
   * ORA-01927 for individual misses of an ALL expansion).
   */
  private expandSystemPrivileges(privileges: string[]): { name: string; fromAll: boolean }[] {
    const expanded: { name: string; fromAll: boolean }[] = [];
    for (const priv of privileges) {
      if (priv.toUpperCase() === 'ALL PRIVILEGES') {
        // GRANT ALL PRIVILEGES never includes the administrative
        // (password-file) privileges — they are granted explicitly only.
        for (const p of ORACLE_SYSTEM_PRIVILEGES) {
          if (!isAdministrativePrivilege(p)) expanded.push({ name: p, fromAll: true });
        }
      } else {
        expanded.push({ name: priv, fromAll: false });
      }
    }
    return expanded;
  }

  /**
   * Validate the object of a GRANT exists — granting on a missing table /
   * schema must raise ORA-00942 (Oracle never silently succeeds).
   */
  private assertGrantableObjectExists(schema: string, objName: string): void {
    const tableExists = this.storage.getTableMeta(schema, objName) != null;
    const viewExists = this.storage.getViewMeta?.(schema, objName) != null;
    const sequenceExists = this.storage.getSequence?.(schema, objName) != null;
    if (tableExists || viewExists || sequenceExists) return;
    // Could still be a PL/SQL object — query the catalog provider.
    const procExists = this.catalog.getStoredUnits().some(u => u.schema === schema && u.name === objName);
    if (!procExists) {
      throw new OracleError(942, 'table or view does not exist');
    }
  }

  executeGrant(stmt: GrantStatement): ResultSet {
    const catalog = this.catalog;
    const grantees = this.granteesOf(stmt);
    // Oracle refuses the entire statement with ORA-01917 if any name is wrong.
    this.privileges.assertGranteesExist(grantees);
    if (stmt.objectType === 'DIRECTORY') {
      const dirName = stmt.objectName!.toUpperCase();
      if (!this.catalog.getDirectory(dirName)) {
        throw new OracleError(4043, `object ${dirName} does not exist`);
      }
      this.privileges.requireGrantableObjectPrivileges('SYS', dirName, stmt.privileges);
      for (const grantee of grantees) {
        for (const priv of stmt.privileges) {
          this.catalog.grantTablePrivilege(grantee, priv, 'SYS', dirName, stmt.withGrantOption);
        }
      }
      return emptyResult('Grant succeeded.');
    }
    // Granting system privs / roles requires GRANT ANY PRIVILEGE or DBA.
    // Granting an object priv requires owning the object or having WITH GRANT OPTION.
    if (stmt.objectName) {
      const user = this.context.currentUser;
      const schema = this.resolveSchema(stmt.objectSchema);
      const objName = stmt.objectName.toUpperCase();
      this.privileges.requireGrantableObjectPrivileges(schema, objName, stmt.privileges);
      this.assertGrantableObjectExists(schema, objName);
      // Self-grant (owner grants to themselves) — ORA-01749.
      for (const grantee of grantees) {
        if (grantee.toUpperCase() === schema) {
          throw new OracleError(1749, 'you may not GRANT/REVOKE privileges to/from yourself');
        }
      }
      for (const grantee of grantees) {
        for (const priv of stmt.privileges) {
          const cols = stmt.privilegeColumns?.[priv.toUpperCase()];
          if (cols && cols.length > 0) {
            // Column-level grant: only DBA_COL_PRIVS, not DBA_TAB_PRIVS.
            for (const c of cols) {
              const colExists = this.storage.getTableMeta(schema, objName)?.columns.some(co => co.name === c.toUpperCase());
              if (!colExists) throw new OracleError(904, `"${c.toUpperCase()}": invalid identifier`);
              catalog.grantColumnPrivilege(grantee, priv, schema, stmt.objectName, c, user, stmt.withGrantOption);
            }
          } else {
            catalog.grantTablePrivilege(grantee, priv, schema, stmt.objectName, stmt.withGrantOption);
          }
        }
      }
    } else {
      this.privileges.requireSystemPrivilege('GRANT ANY PRIVILEGE', 'GRANT ANY ROLE');
      const expanded = this.expandSystemPrivileges(stmt.privileges);
      for (const grantee of grantees) {
        for (const { name: priv } of expanded) {
          if (catalog.roleExists(priv)) {
            this.privileges.assertNoCircularRoleGrant(grantee, priv);
            catalog.grantRole(grantee, priv, stmt.withAdminOption);
          } else {
            // Self-grant of SYSDBA/SYSOPER/etc on SYS — ORA-01931.
            if (grantee.toUpperCase() === 'SYS') {
              throw new OracleError(1931, 'role/privilege cannot be granted to SYS');
            }
            if (isAdministrativePrivilege(priv)) {
              // Administrative privileges land in the password file
              // (V$PWFILE_USERS), not DBA_SYS_PRIVS.
              catalog.grantAdminPrivilege(grantee, priv);
            } else {
              catalog.grantSystemPrivilege(grantee, priv, stmt.withAdminOption || stmt.withGrantOption);
            }
          }
        }
      }
    }
    return emptyResult('Grant succeeded.');
  }

  executeRevoke(stmt: RevokeStatement): ResultSet {
    const catalog = this.catalog;
    const grantees = this.granteesOf(stmt);
    // ORA-01917 stops the whole statement before any mutation, matching Oracle.
    this.privileges.assertGranteesExist(grantees);
    if (stmt.objectType === 'DIRECTORY') {
      const dirName = stmt.objectName!.toUpperCase();
      for (const grantee of grantees) {
        for (const priv of stmt.privileges) {
          catalog.revokeTablePrivilege(grantee, priv, 'SYS', dirName);
        }
      }
      return emptyResult('Revoke succeeded.');
    }
    // REVOKE {ADMIN|GRANT} OPTION FOR — only strip the option flag,
    // keep the underlying privilege row.
    if (stmt.strippingOption) {
      for (const grantee of grantees) {
        for (const priv of stmt.privileges) {
          if (stmt.objectName) {
            const schema = this.resolveSchema(stmt.objectSchema);
            catalog.stripTableGrantOption(grantee, priv, schema, stmt.objectName);
          } else if (catalog.roleExists(priv)) {
            catalog.stripRoleAdminOption(grantee, priv);
          } else {
            catalog.stripSystemGrantOption(grantee, priv);
          }
        }
      }
      return emptyResult('Revoke succeeded.');
    }
    if (stmt.objectName) {
      const schema = stmt.objectSchema || this.context.currentSchema;
      for (const grantee of grantees) {
        for (const priv of stmt.privileges) {
          const cols = stmt.privilegeColumns?.[priv.toUpperCase()];
          if (cols && cols.length > 0) {
            for (const c of cols) catalog.revokeColumnPrivilege(grantee, priv, schema, stmt.objectName, c);
          } else {
            catalog.revokeTablePrivilege(grantee, priv, schema, stmt.objectName);
          }
        }
      }
    } else {
      const expanded = this.expandSystemPrivileges(stmt.privileges);
      for (const grantee of grantees) {
        for (const entry of expanded) {
          const granteeU = grantee.toUpperCase();
          const privU = entry.name.toUpperCase();
          if (catalog.roleExists(entry.name)) {
            const hadRole = catalog.getRoleGrants().some(r => r.grantee === granteeU && r.role === privU);
            if (!hadRole && !entry.fromAll) {
              throw new OracleError(1924, `role '${privU}' not granted or does not exist`);
            }
            catalog.revokeRole(grantee, entry.name);
          } else if (isAdministrativePrivilege(entry.name)) {
            const hadPriv = catalog.isPasswordFileMember(granteeU, privU);
            if (!hadPriv && !entry.fromAll) {
              throw new OracleError(1927, `cannot REVOKE privileges you did not grant`);
            }
            catalog.revokeAdminPrivilege(grantee, entry.name);
          } else {
            const hadPriv = catalog.getSysPrivilegeGrants().some(p => p.grantee === granteeU && p.privilege === privU)
              || catalog.getTablePrivilegeGrants().some(p => p.grantee === granteeU && p.privilege === privU);
            if (!hadPriv && !entry.fromAll) {
              throw new OracleError(1927, `cannot REVOKE privileges you did not grant`);
            }
            catalog.revokeSystemPrivilege(grantee, entry.name);
          }
        }
      }
    }
    return emptyResult('Revoke succeeded.');
  }

  // ── AUDIT / NOAUDIT (traditional auditing) ────────────────────────

  executeAudit(stmt: AuditStatement): ResultSet {
    // AUDIT requires AUDIT SYSTEM (for statement / privilege audit) or
    // AUDIT ANY (for object audit). Real Oracle refuses anything else
    // with ORA-01031.
    if (stmt.onObject) {
      this.privileges.requireSystemPrivilege('AUDIT ANY');
    } else {
      this.privileges.requireSystemPrivilege('AUDIT SYSTEM');
    }
    const catalog = this.catalog;
    const options = stmt.auditOptions ?? [stmt.auditOption];
    const byCode = stmt.byMode === 'SESSION' ? 'S' : 'A';
    // WHENEVER [NOT] SUCCESSFUL scopes which half is audited.
    const objSuccess = stmt.whenever === 'NOT SUCCESSFUL' ? '-' : byCode;
    const objFailure = stmt.whenever === 'SUCCESSFUL' ? '-' : byCode;

    if (stmt.onObject) {
      const schema = (stmt.onObject.schema ?? this.context.currentUser).toUpperCase();
      const object = stmt.onObject.name.toUpperCase();
      for (const action of options) {
        catalog.setObjectAuditOption(schema, object, action, {
          success: objSuccess as 'A' | 'S' | '-',
          failure: objFailure as 'A' | 'S' | '-',
        });
      }
      return emptyResult('Audit succeeded.');
    }

    const mode = stmt.byMode === 'SESSION' ? 'BY SESSION' : 'BY ACCESS';
    const success = stmt.whenever === 'NOT SUCCESSFUL' ? 'NOT SET' : mode;
    const failure = stmt.whenever === 'SUCCESSFUL' ? 'NOT SET' : mode;
    for (const auditOption of options) {
      catalog.addStmtAuditOption({
        auditOption,
        userName: stmt.byUser ?? null,
        success,
        failure,
      });
    }
    return emptyResult('Audit succeeded.');
  }

  executeNoaudit(stmt: NoauditStatement): ResultSet {
    if (stmt.onObject) {
      this.privileges.requireSystemPrivilege('AUDIT ANY');
    } else {
      this.privileges.requireSystemPrivilege('AUDIT SYSTEM');
    }
    const catalog = this.catalog;
    const options = stmt.auditOptions ?? [stmt.auditOption];
    if (stmt.onObject) {
      const schema = (stmt.onObject.schema ?? this.context.currentUser).toUpperCase();
      const object = stmt.onObject.name.toUpperCase();
      for (const action of options) {
        catalog.clearObjectAuditOption(schema, object, action);
      }
      return emptyResult('Noaudit succeeded.');
    }
    for (const auditOption of options) {
      catalog.removeStmtAuditOption(auditOption, stmt.byUser ?? null);
    }
    return emptyResult('Noaudit succeeded.');
  }

  // ── Unified audit policies ───────────────────────────────────────

  executeCreateAuditPolicy(stmt: CreateAuditPolicyStatement): ResultSet {
    this.privileges.requireSystemPrivilege('AUDIT SYSTEM');
    this.catalog.createUnifiedAuditPolicy({
      name: stmt.name,
      actions: stmt.actions,
      objectSchema: stmt.onObject?.schema,
      objectName: stmt.onObject?.name,
      roles: stmt.roles,
    });
    return emptyResult('Audit policy created.');
  }

  executeDropAuditPolicy(stmt: DropAuditPolicyStatement): ResultSet {
    this.privileges.requireSystemPrivilege('AUDIT SYSTEM');
    if (!this.catalog.dropUnifiedAuditPolicy(stmt.name)) {
      throw new OracleError(46365, `audit policy ${stmt.name} does not exist`);
    }
    return emptyResult('Audit policy dropped.');
  }

  executeAuditPolicy(stmt: AuditPolicyStatement): ResultSet {
    this.privileges.requireSystemPrivilege('AUDIT SYSTEM');
    if (stmt.disable) {
      this.catalog.disableUnifiedAuditPolicy(stmt.policyName, stmt.byUsers);
      return emptyResult('Noaudit succeeded.');
    }
    this.catalog.enableUnifiedAuditPolicy(stmt.policyName, stmt.byUsers, stmt.exceptUsers);
    return emptyResult('Audit succeeded.');
  }

  // ── ADMINISTER KEY MANAGEMENT (TDE) ──────────────────────────────

  executeAdministerKeyManagement(stmt: AdministerKeyManagementStatement): ResultSet {
    this.privileges.requireSystemPrivilege('ADMINISTER KEY MANAGEMENT');
    const catalog = this.catalog;
    const creator = this.context.currentUser;

    switch (stmt.operation) {
      case 'CREATE_KEYSTORE': {
        if (!stmt.location) throw new OracleError(46651, 'keystore location is required');
        catalog.configureTdeWallet(stmt.location, 'PASSWORD');
        return emptyResult('keystore altered.\nThe operation succeeded.');
      }
      case 'OPEN_KEYSTORE': {
        catalog.openTdeWallet();
        return emptyResult('keystore altered.\nThe operation succeeded.');
      }
      case 'CLOSE_KEYSTORE': {
        catalog.closeTdeWallet();
        return emptyResult('keystore altered.\nThe operation succeeded.');
      }
      case 'SET_KEY': {
        const tag = stmt.tag ?? '';
        catalog.addTdeMasterKey(tag, creator);
        return emptyResult('keystore altered.\nThe operation succeeded.');
      }
      case 'CREATE_AUTO_LOGIN_KEYSTORE': {
        const w = catalog.getTdeWallet();
        if (!w) {
          if (!stmt.location) throw new OracleError(46651, 'keystore location is required');
          catalog.configureTdeWallet(stmt.location, 'AUTOLOGIN');
        }
        return emptyResult('keystore altered.\nThe operation succeeded.');
      }
      case 'BACKUP_KEYSTORE':
      case 'MERGE_KEYSTORE':
      case 'EXPORT_KEYS':
      case 'IMPORT_KEYS':
        // No state mutation needed — succeed with the canonical message.
        return emptyResult('keystore altered.\nThe operation succeeded.');
      default:
        return emptyResult('keystore altered.\nThe operation succeeded.');
    }
  }

  // ── COMMENT ON … IS … ────────────────────────────────────────────

  executeComment(stmt: CommentStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    // Commenting on a foreign schema requires COMMENT ANY TABLE.
    if (schema !== this.context.currentUser && this.context.currentUser !== 'SYS') {
      this.privileges.requireSystemPrivilege('COMMENT ANY TABLE');
    }
    if (stmt.target === 'COLUMN' && stmt.columnName) {
      this.catalog.setColumnComment(schema, stmt.tableName, stmt.columnName, stmt.text);
    } else {
      this.catalog.setTableComment(schema, stmt.tableName, stmt.text);
    }
    return emptyResult('Comment created.');
  }
}

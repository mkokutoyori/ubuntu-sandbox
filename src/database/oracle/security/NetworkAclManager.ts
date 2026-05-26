/**
 * NetworkAclManager — Oracle 12c+ network-ACL administration
 * (DBMS_NETWORK_ACL_ADMIN).
 *
 * Real Oracle gates `UTL_HTTP`, `UTL_SMTP`, `UTL_TCP` etc. through ACLs
 * that bind a (host, lower-port, upper-port) tuple to a list of
 * principals with `connect`/`resolve`/`use_client_certificates`
 * privileges. The catalog stores three views:
 *   - DBA_NETWORK_ACLS — host/port → ACL name mapping
 *   - DBA_NETWORK_ACL_PRIVILEGES — ACL → principal/privilege rows
 *   - DBA_HOST_ACES — flattened (host, principal, privilege) view
 *
 * This manager owns the in-memory state behind those three views and
 * exposes the same DBMS API surface (APPEND_HOST_ACE / REMOVE_HOST_ACE
 * etc.) the DBA would use in production.
 */

export interface NetworkAcl {
  readonly aclName: string;
  readonly host: string;
  readonly lowerPort: number | null;
  readonly upperPort: number | null;
  readonly aclOwner: string;
  readonly aclId: string;
  readonly createdAt: Date;
}

export type NetworkPrivilege = 'connect' | 'resolve' | 'use-client-certificates' | 'use-passwords';

export interface NetworkAclPrivilege {
  readonly aclName: string;
  readonly principal: string;
  readonly privilege: NetworkPrivilege;
  /** 'GRANT' or 'DENY'. */
  readonly grantOrDeny: 'GRANT' | 'DENY';
  readonly isGrant: boolean;
  readonly invertedPrincipal: boolean;
  readonly principalType: 'USER' | 'ROLE';
  readonly startDate: Date | null;
  readonly endDate: Date | null;
  readonly position: number;
}

export class NetworkAclManager {
  private acls: NetworkAcl[] = [];
  private privs: NetworkAclPrivilege[] = [];
  private aclIdSeq = 1000;

  constructor(seedDefaults: boolean = true) {
    if (seedDefaults) this.seedDefaults();
  }

  private seedDefaults(): void {
    // Real fresh installs ship two default ACLs for OJVM permissions.
    // We emulate `oracle-sysman-ocm-Resolve-Access.xml` (SYS → resolve)
    // and a connect ACL for the simulator's seed schemas.
    this.appendHostAce('localhost', null, null,
      [{ principal: 'SYS', privilege: 'resolve', grantOrDeny: 'GRANT' }]);
    this.appendHostAce('localhost', 1521, 1521,
      [{ principal: 'HR', privilege: 'connect', grantOrDeny: 'GRANT' },
       { principal: 'FCUBSLIVE', privilege: 'connect', grantOrDeny: 'GRANT' }]);
  }

  // ── DBMS_NETWORK_ACL_ADMIN surface ─────────────────────────────────

  /**
   * Append one or more access-control entries scoped to a host:port
   * tuple. Each call creates an ACL if no matching tuple exists, or
   * augments the existing one. Mirrors `DBMS_NETWORK_ACL_ADMIN
   * .APPEND_HOST_ACE`.
   */
  appendHostAce(
    host: string,
    lowerPort: number | null,
    upperPort: number | null,
    aces: Array<{ principal: string; privilege: NetworkPrivilege;
                  grantOrDeny?: 'GRANT' | 'DENY'; principalType?: 'USER' | 'ROLE';
                  startDate?: Date; endDate?: Date }>,
  ): string {
    const key = this.aclKey(host, lowerPort, upperPort);
    let acl = this.acls.find(a => this.aclKey(a.host, a.lowerPort, a.upperPort) === key);
    if (!acl) {
      acl = {
        aclName: `NETWORK_ACL_${this.aclIdSeq.toString(16).toUpperCase()}.xml`,
        host: host.toLowerCase(),
        lowerPort, upperPort, aclOwner: 'SYS',
        aclId: `0000000000000000${this.aclIdSeq.toString(16).toUpperCase()}`,
        createdAt: new Date(),
      };
      this.acls.push(acl);
      this.aclIdSeq++;
    }
    for (const ace of aces) {
      const pos = this.privs.filter(p => p.aclName === acl!.aclName).length + 1;
      this.privs.push({
        aclName: acl.aclName,
        principal: ace.principal.toUpperCase(),
        privilege: ace.privilege,
        grantOrDeny: ace.grantOrDeny ?? 'GRANT',
        isGrant: (ace.grantOrDeny ?? 'GRANT') === 'GRANT',
        invertedPrincipal: false,
        principalType: ace.principalType ?? 'USER',
        startDate: ace.startDate ?? null,
        endDate: ace.endDate ?? null,
        position: pos,
      });
    }
    return acl.aclName;
  }

  /** Remove every entry matching the (host, principal, privilege) triple. */
  removeHostAce(host: string, lowerPort: number | null, upperPort: number | null,
                principal: string, privilege: NetworkPrivilege): number {
    const key = this.aclKey(host, lowerPort, upperPort);
    const acl = this.acls.find(a => this.aclKey(a.host, a.lowerPort, a.upperPort) === key);
    if (!acl) return 0;
    const before = this.privs.length;
    const p = principal.toUpperCase();
    this.privs = this.privs.filter(x =>
      !(x.aclName === acl.aclName && x.principal === p && x.privilege === privilege));
    return before - this.privs.length;
  }

  /** Drop a host's ACL entirely. */
  dropHostAcl(host: string): boolean {
    const h = host.toLowerCase();
    const acl = this.acls.find(a => a.host === h);
    if (!acl) return false;
    this.privs = this.privs.filter(p => p.aclName !== acl.aclName);
    this.acls = this.acls.filter(a => a.aclName !== acl.aclName);
    return true;
  }

  // ── Read APIs ──────────────────────────────────────────────────────

  getAcls(): readonly NetworkAcl[] { return this.acls; }
  getPrivileges(): readonly NetworkAclPrivilege[] { return this.privs; }

  /** Flattened view used by DBA_HOST_ACES. */
  getHostAces(): Array<{ host: string; lowerPort: number | null; upperPort: number | null;
                         aclName: string; principal: string; privilege: NetworkPrivilege;
                         grantOrDeny: 'GRANT' | 'DENY'; aceOrder: number;
                         startDate: Date | null; endDate: Date | null; principalType: string }> {
    const out: ReturnType<NetworkAclManager['getHostAces']> = [];
    for (const acl of this.acls) {
      const aces = this.privs.filter(p => p.aclName === acl.aclName);
      for (const ace of aces) {
        out.push({
          host: acl.host, lowerPort: acl.lowerPort, upperPort: acl.upperPort,
          aclName: acl.aclName, principal: ace.principal, privilege: ace.privilege,
          grantOrDeny: ace.grantOrDeny, aceOrder: ace.position,
          startDate: ace.startDate, endDate: ace.endDate, principalType: ace.principalType,
        });
      }
    }
    return out;
  }

  private aclKey(host: string, lo: number | null, up: number | null): string {
    return `${host.toLowerCase()}#${lo ?? '*'}#${up ?? '*'}`;
  }
}

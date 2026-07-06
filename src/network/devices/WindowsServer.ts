/**
 * WindowsServer — Windows Server 2022 Standard.
 *
 * PRD Phase 1 (docs/PRD-Windows-Server.md §5 P1): a thin subclass of
 * `WindowsPC`, mirroring the established `LinuxServer extends LinuxMachine`
 * pattern. All cmd/PowerShell/services/filesystem/registry/event-log
 * behavior is inherited unchanged — `WindowsPC` already derives the correct
 * "Windows Server 2022 Standard" identity (systeminfo, wmic, registry,
 * Get-ComputerInfo, $PSVersionTable.OS) from the `'windows-server'` device
 * type passed to `EndHost`/`PSRegistryProvider`.
 *
 * This class exists (rather than just instantiating `WindowsPC('windows-
 * server', …)` directly) so later PRD phases have a dedicated home for
 * server-only state that a client must never see: the role/feature model
 * (P2), the SMB server (P3), AD DS (P5), DNS/DHCP/NPS/IIS role hosting
 * (P7-P11) all attach here, not to `WindowsPC`.
 */

import { WindowsPC } from './WindowsPC';
import { RoleManager } from './windows/server/RoleManager';
import { DirectoryStore } from './windows/server/ad/DirectoryStore';
import { WindowsDnsServerRole } from './windows/server/dns/WindowsDnsServerRole';
import { WindowsDhcpServerRole } from './windows/server/dhcp/WindowsDhcpServerRole';
import { WindowsNpsRole } from './windows/server/nps/WindowsNpsRole';
import { WindowsIisRole } from './windows/server/iis/WindowsIisRole';
import { WindowsAdcsRole } from './windows/server/adcs/CaRole';
import { randomSessionKey } from '@/network/kerberos/crypto';
import { dialLdap } from './windows/server/ad/ldap/LdapClient';
import { pullReplication } from './windows/server/ad/replication/ReplicationSession';
import { createForest, joinForestAsChildDomain, getForestForDomain, type Forest } from './windows/server/ad/forest/Forest';
import { mirroredDirection, type TrustDirection, type TrustInfo, type TrustRecord } from './windows/server/ad/forest/TrustRelationship';

export interface AdDsOpResult { ok: boolean; message: string }

/** Real DC promotion auto-creates this site (PRD-Windows-Server-Advanced.md §5 P6) — matches the name `WinDomainDiag.cmdNltest` has always reported. */
const DEFAULT_SITE_NAME = 'Default-First-Site-Name';

export class WindowsServer extends WindowsPC {
  private readonly roleManager: RoleManager = new RoleManager(this.getServiceManager());
  private directoryStore: DirectoryStore | null = null;
  private dnsServerRoleInstance: WindowsDnsServerRole | null = null;
  private dhcpServerRoleInstance: WindowsDhcpServerRole | null = null;
  private npsRoleInstance: WindowsNpsRole | null = null;
  private iisRoleInstance: WindowsIisRole | null = null;
  private adcsRoleInstance: WindowsAdcsRole | null = null;

  constructor(name: string = 'WinServer', x: number = 0, y: number = 0) {
    super('windows-server', name, x, y);
  }

  /** PRD Phase 2 (§5 P2): Server Manager's role/feature model. */
  getRoleManager(): RoleManager { return this.roleManager; }

  /** PRD Phase 5 (§5 P5): the real AD DS directory, once `Install-ADDSForest` has promoted this server. */
  getDirectoryStore(): DirectoryStore | null { return this.directoryStore; }

  /**
   * PRD Phase 7 (§5 P7): the DNS Server role, hosting the real DNS engine
   * over UDP/TCP 53 — null while the `DNS` role isn't installed. Lazily
   * created (and its listeners bound) on first access after
   * `Install-WindowsFeature DNS` succeeds, since `RoleManager` has no
   * generic per-feature install hook to bind the listener at the exact
   * instant the feature installs; any realistic sequence configures the
   * role (via a `DnsServer` cmdlet) immediately after installing it, so
   * this is not observable in practice.
   */
  getDnsServerRole(): WindowsDnsServerRole | null {
    if (!this.roleManager.isInstalled('DNS')) {
      if (this.dnsServerRoleInstance) { this.dnsServerRoleInstance.stop(); this.dnsServerRoleInstance = null; }
      return null;
    }
    if (!this.dnsServerRoleInstance) {
      this.dnsServerRoleInstance = new WindowsDnsServerRole(this);
      this.dnsServerRoleInstance.start();
    }
    return this.dnsServerRoleInstance;
  }

  /**
   * PRD Phase 8 (§5 P8): the DHCP Server role, hosting the real DHCP engine
   * over UDP 67/68 — null while the `DHCP` role isn't installed. Domain
   * context is refreshed on every access (not just at creation) since
   * `Add-Computer`/`Install-ADDSForest` can join/promote this server to a
   * domain after the role was already installed and started.
   */
  getDhcpServerRole(): WindowsDhcpServerRole | null {
    if (!this.roleManager.isInstalled('DHCP')) {
      if (this.dhcpServerRoleInstance) { this.dhcpServerRoleInstance.stop(); this.dhcpServerRoleInstance = null; }
      return null;
    }
    if (!this.dhcpServerRoleInstance) {
      this.dhcpServerRoleInstance = new WindowsDhcpServerRole(this);
      this.dhcpServerRoleInstance.start();
    }
    this.dhcpServerRoleInstance.setDomainContext(
      this.getDirectoryStore() !== null || this.getDomainMembership() !== null,
    );
    return this.dhcpServerRoleInstance;
  }

  /**
   * PRD Phase 9 (§5 P9): the NPS (RADIUS) role, hosting the real RADIUS
   * engine over UDP 1812/1813 — null while the `NPAS` role isn't
   * installed. Resolves users against the local SAM/AD (never a
   * dedicated NPS-only user list).
   */
  getNpsRole(): WindowsNpsRole | null {
    if (!this.roleManager.isInstalled('NPAS')) {
      if (this.npsRoleInstance) { this.npsRoleInstance.stop(); this.npsRoleInstance = null; }
      return null;
    }
    if (!this.npsRoleInstance) {
      this.npsRoleInstance = new WindowsNpsRole(this, this, this.eventLog);
      this.npsRoleInstance.start();
    }
    return this.npsRoleInstance;
  }

  /**
   * PRD Phase 11 (§5 P11): the Web Server (IIS) role, hosting a minimal
   * `W3SVC` + "Default Web Site" over real TCP/80 — null while the
   * `Web-Server` role isn't installed.
   */
  getIisRole(): WindowsIisRole | null {
    if (!this.roleManager.isInstalled('Web-Server')) {
      if (this.iisRoleInstance) { this.iisRoleInstance.stop(); this.iisRoleInstance = null; }
      return null;
    }
    if (!this.iisRoleInstance) {
      this.iisRoleInstance = new WindowsIisRole(this, this.getFileSystem());
      this.iisRoleInstance.start();
    }
    return this.iisRoleInstance;
  }

  /**
   * PRD Phase 13 (§5 P13): the AD CS (Certificate Services) role, `CertSvc`
   * — null while the `AD-Certificate` role isn't installed. Purely local
   * business logic (no network listener, per PRD §2.1.13): `certreq`/
   * `certutil` submit requests directly against this instance, which
   * delegates issuance/signing entirely to `CertificateAuthority` (`src/
   * network/pki/`, already mature) — no new cryptographic primitive.
   */
  getAdcsRole(): WindowsAdcsRole | null {
    if (!this.roleManager.isInstalled('AD-Certificate')) {
      this.adcsRoleInstance = null;
      return null;
    }
    if (!this.adcsRoleInstance) {
      this.adcsRoleInstance = new WindowsAdcsRole(() => this.simulatedDate().getTime());
    }
    return this.adcsRoleInstance;
  }

  /**
   * `Install-ADDSForest` — promotes this server to the first domain
   * controller of a brand-new forest. Requires the AD-Domain-Services
   * role already installed (real dependency order: `Install-WindowsFeature
   * AD-Domain-Services` then `Install-ADDSForest`), and that this server
   * isn't already a DC. Creates the domain's `DirectoryStore`, the DC's
   * own computer account under the Domain Controllers OU, and opens the
   * real TCP/389 LDAP listener (already registered at boot, gated on
   * `getDirectoryStore()` being non-null).
   */
  installADDSForest(domainName: string, netbiosName: string | undefined, safeModeAdminPassword: string): AdDsOpResult {
    if (!this.roleManager.isInstalled('AD-Domain-Services')) {
      return { ok: false, message: 'Install-ADDSForest : The Active Directory Domain Services role is not installed on this computer.' };
    }
    if (this.directoryStore) {
      return { ok: false, message: 'Install-ADDSForest : This computer is already configured as a domain controller.' };
    }
    const netbios = netbiosName ?? domainName.split('.')[0].toUpperCase();
    this.directoryStore = new DirectoryStore(domainName, netbios, safeModeAdminPassword);
    this.directoryStore.promoteDomainController(this.getHostname(), safeModeAdminPassword);
    this.directoryStore.ensureKrbtgtPrincipal(randomSessionKey());
    this.directoryStore.newSite(DEFAULT_SITE_NAME);
    createForest(domainName, netbios, this.directoryStore.getSchemaValidatorForSharing());
    this.provisionSysvol(domainName);
    this.registerDcServices();
    this.provisionDomainDnsZone(domainName);
    this.provisionDefaultDomainPolicy();
    return { ok: true, message: '' };
  }

  /**
   * `New-ADDomain -NewDomainName ... -ParentDomainName ...`
   * (PRD-Windows-Server-Advanced.md §5 P8): creates a new *child* domain
   * of an existing forest — a genuinely separate `DirectoryStore` (its
   * own Users/Computers/default groups, its own domain root), but wired
   * to the SAME `SchemaValidator` instance as the parent's forest so a
   * schema change made through either domain is enforced in both — see
   * `forest/Forest.ts`'s header comment for why this is shared by
   * reference rather than replicated as a separate NC.
   */
  newADDomain(
    newDomainDnsName: string, netbiosName: string | undefined, parentDomainName: string, parentDcAddress: string,
    credentialUser: string, credentialPassword: string, safeModeAdminPassword: string,
  ): AdDsOpResult {
    if (!this.roleManager.isInstalled('AD-Domain-Services')) {
      return { ok: false, message: 'New-ADDomain : The Active Directory Domain Services role is not installed on this computer.' };
    }
    if (this.directoryStore) {
      return { ok: false, message: 'New-ADDomain : This computer is already configured as a domain controller.' };
    }

    const conn = dialLdap(this.getTcpStack(), parentDcAddress);
    if (!conn.ok || !conn.client) {
      return { ok: false, message: 'New-ADDomain : The specified domain either does not exist or could not be contacted.' };
    }
    const bind = conn.client.bind(credentialUser, credentialPassword);
    conn.client.unbind();
    if (!bind.ok) {
      return { ok: false, message: 'New-ADDomain : Logon failure: unknown user name or bad password.' };
    }

    const netbios = netbiosName ?? newDomainDnsName.split('.')[0].toUpperCase();
    const join = joinForestAsChildDomain(parentDomainName, newDomainDnsName, netbios);
    if (!join.ok) {
      return { ok: false, message: `New-ADDomain : ${join.message}` };
    }

    this.directoryStore = new DirectoryStore(newDomainDnsName, netbios, safeModeAdminPassword, { sharedSchemaValidator: join.schemaValidator });
    this.directoryStore.promoteDomainController(this.getHostname(), safeModeAdminPassword);
    this.directoryStore.ensureKrbtgtPrincipal(randomSessionKey());
    this.directoryStore.newSite(DEFAULT_SITE_NAME);
    this.provisionSysvol(newDomainDnsName);
    this.registerDcServices();
    this.provisionDomainDnsZone(newDomainDnsName);
    this.provisionDefaultDomainPolicy();
    return { ok: true, message: '' };
  }

  /** `Get-ADForest` — the forest this domain belongs to, or null if this server isn't a DC. */
  getForest(): Forest | null {
    if (!this.directoryStore) return null;
    return getForestForDomain(this.directoryStore.dnsName);
  }

  /**
   * `New-ADTrust`/`netdom trust` (PRD-Windows-Server-Advanced.md §5 P9):
   * establishes a simple trust with the domain reached at
   * `remoteDcAddress` — a real LDAP dial+bind verifies reachability/
   * credentials (mirrors `New-ADDomain`), then a freshly generated
   * interrealm key is recorded locally and pushed, direction-flipped, to
   * the remote domain's own directory via a real LDAP `AddRequest`.
   * Unlike the forest's shared `SchemaValidator` (§5 P8), a trust spans
   * two genuinely independent directories, so there is no single object
   * to share by reference — see `TrustRelationship.ts`'s header comment.
   */
  newADTrust(
    remoteRealm: string, remoteDcAddress: string, direction: TrustDirection, transitive: boolean,
    credentialUser: string, credentialPassword: string,
  ): AdDsOpResult {
    if (!this.directoryStore) {
      return { ok: false, message: 'New-ADTrust : This computer is not configured as a domain controller.' };
    }
    const localRealm = this.directoryStore.getRealm();
    if (remoteRealm.toUpperCase() === localRealm.toUpperCase()) {
      return { ok: false, message: 'New-ADTrust : A trust cannot be created between a domain and itself.' };
    }

    const conn = dialLdap(this.getTcpStack(), remoteDcAddress);
    if (!conn.ok || !conn.client) {
      return { ok: false, message: 'New-ADTrust : The specified domain either does not exist or could not be contacted.' };
    }
    const bind = conn.client.bind(credentialUser, credentialPassword);
    if (!bind.ok) {
      conn.client.unbind();
      return { ok: false, message: 'New-ADTrust : Logon failure: unknown user name or bad password.' };
    }

    const interrealmSecret = randomSessionKey();
    const localAdd = this.directoryStore.addTrust(remoteRealm, direction, transitive, interrealmSecret);
    if (!localAdd.ok) {
      conn.client.unbind();
      return { ok: false, message: `New-ADTrust : ${localAdd.message}` };
    }

    const remoteRootDn = remoteRealm.split('.').map(p => `DC=${p}`).join(',');
    const remoteTrustDn = `CN=${localRealm},CN=System,${remoteRootDn}`;
    const push = conn.client.add(remoteTrustDn, [
      { type: 'objectClass', values: ['top', 'trustedDomain'] },
      { type: 'cn', values: [localRealm] },
      { type: 'trustPartner', values: [localRealm] },
      { type: 'trustDirection', values: [mirroredDirection(direction)] },
      { type: 'trustAttributes', values: [transitive ? 'transitive' : 'nonTransitive'] },
      { type: 'trustAuthIncoming', values: [interrealmSecret] },
    ]);
    conn.client.unbind();
    if (!push.ok) {
      return { ok: false, message: `New-ADTrust : ${push.result.diagnosticMessage || 'failed to establish the remote side of the trust'}` };
    }
    return { ok: true, message: '' };
  }

  /** `Get-ADTrust` — null if no trust with `remoteRealm` exists (or this server isn't a DC). */
  getTrust(remoteRealm: string): TrustRecord | null {
    return this.directoryStore?.getTrust(remoteRealm) ?? null;
  }

  listTrusts(): TrustInfo[] {
    return this.directoryStore?.listTrusts() ?? [];
  }

  /**
   * `Install-ADDSDomainController` (PRD-Windows-Server-Advanced.md §5 P5)
   * — promotes this server as an *additional* DC of a domain that
   * already exists elsewhere, reached at `sourceDcAddress`. Real DCPromo
   * order: verify the domain is reachable and the credential is valid
   * (a real LDAP bind — the same wire dialogue `Add-Computer` uses),
   * then create an empty local `DirectoryStore` and perform one full
   * replication pull from the source DC (§5 P4) *before* adding this
   * server's own computer account, since that account's parent OU only
   * exists once the sync has populated it.
   */
  installADDSDomainController(
    domainName: string, netbiosName: string | undefined, sourceDcAddress: string,
    credentialUser: string, credentialPassword: string, safeModeAdminPassword: string,
  ): AdDsOpResult {
    if (!this.roleManager.isInstalled('AD-Domain-Services')) {
      return { ok: false, message: 'Install-ADDSDomainController : The Active Directory Domain Services role is not installed on this computer.' };
    }
    if (this.directoryStore) {
      return { ok: false, message: 'Install-ADDSDomainController : This computer is already configured as a domain controller.' };
    }

    const conn = dialLdap(this.getTcpStack(), sourceDcAddress);
    if (!conn.ok || !conn.client) {
      return { ok: false, message: 'Install-ADDSDomainController : The specified domain either does not exist or could not be contacted.' };
    }
    const bind = conn.client.bind(credentialUser, credentialPassword);
    conn.client.unbind();
    if (!bind.ok) {
      return { ok: false, message: 'Install-ADDSDomainController : Logon failure: unknown user name or bad password.' };
    }

    const netbios = netbiosName ?? domainName.split('.')[0].toUpperCase();
    const store = new DirectoryStore(domainName, netbios, safeModeAdminPassword, { skipSeed: true });
    const sync = pullReplication(this.getTcpStack(), sourceDcAddress, store);
    /**
     * The initial sync (PRD-Windows-Server-Advanced.md §5 P12) has no
     * site topology yet to classify intra-/inter-site (this DC isn't
     * promoted until just below) — recorded as `intra-site`, matching
     * real DCPromo's own initial-sync step, which always targets a
     * source DC the installer explicitly chose as reachable. Publishing
     * only (no direct store write) — a `ReplicationSignalRefreshActor`
     * subscribing on this device's bus feeds the `ReplicationSignalStore`.
     */
    this.getBus().publish(
      sync.ok
        ? {
            topic: 'replication.pull.completed',
            payload: { deviceId: this.getHostname(), invocationId: store.getInvocationId(), partnerAddress: sourceDcAddress, applied: sync.applied, siteRelation: 'intra-site' },
          }
        : {
            topic: 'replication.pull.failed',
            payload: { deviceId: this.getHostname(), invocationId: store.getInvocationId(), partnerAddress: sourceDcAddress, error: sync.error ?? 'unknown error', siteRelation: 'intra-site' },
          },
    );
    if (!sync.ok) {
      return { ok: false, message: `Install-ADDSDomainController : Initial synchronization with ${sourceDcAddress} failed: ${sync.error}` };
    }
    const promote = store.promoteDomainController(this.getHostname(), safeModeAdminPassword);
    if (!promote.ok) {
      return { ok: false, message: `Install-ADDSDomainController : ${promote.message}` };
    }
    this.directoryStore = store;
    this.provisionSysvol(domainName);
    this.registerDcServices();
    this.provisionDomainDnsZone(domainName);
    return { ok: true, message: '' };
  }

  /**
   * Real DC promotion auto-creates "Default Domain Policy", linked to
   * the domain root, carrying the domain's password/lockout policy
   * (PRD §5 P10) — applied to members via `gpupdate /force` in place of
   * their local `WindowsAccountsPolicy`. Values mirror real Windows
   * Server's fresh-forest defaults.
   */
  private provisionDefaultDomainPolicy(): void {
    const store = this.getDirectoryStore()!;
    store.newGpo('Default Domain Policy');
    store.setGpoSettings('Default Domain Policy', {
      accountPolicy: {
        minPasswordLength: 7, passwordHistoryLength: 24,
        maxPasswordAge: 42, minPasswordAge: 1,
        lockoutThreshold: 5, lockoutDurationMinutes: 30, lockoutWindowMinutes: 30,
      },
    });
    store.newGPLink('Default Domain Policy', store.getDomainDn());
  }

  /**
   * Real DC promotion creates the domain's DNS zone with the DC locator
   * SRV records and the DC's own A record (PRD §5 P7) — only when the DNS
   * Server role is already installed on this server (AD-integrated DNS is
   * the common real-world setup, but DNS remains a separate, optional
   * role here; if absent, promotion still succeeds without a zone).
   */
  private provisionDomainDnsZone(domainName: string): void {
    const dns = this.getDnsServerRole();
    if (!dns) return;
    if (dns.getZone(domainName)) return;
    dns.addPrimaryZone(domainName);
    const hostname = this.getHostname();
    const ownIp = this.getInterfaces().map(p => p.getIPAddress()).find((ip): ip is NonNullable<typeof ip> => ip !== null);
    if (ownIp) dns.addARecord(domainName, hostname, ownIp.toString());
    const dcTarget = `${hostname}.${domainName}`;
    dns.addSrvRecord(domainName, '_ldap._tcp.dc._msdcs', { priority: 0, weight: 100, port: 389, target: dcTarget });
    dns.addSrvRecord(domainName, '_kerberos._tcp.dc._msdcs', { priority: 0, weight: 100, port: 88, target: dcTarget });
  }

  /** Real DC promotion registers `NTDS`/`Netlogon`/`Kdc` with the SCM (PRD §5 P6) — `dcdiag`/`nltest` read their state. */
  private registerDcServices(): void {
    const svcMgr = this.getServiceManager();
    svcMgr.addService('NTDS', 'Active Directory Domain Services', 'AD DS Domain Controller service',
      { account: 'NT AUTHORITY\\SYSTEM', processName: 'lsass.exe', binaryPath: 'C:\\Windows\\System32\\lsass.exe' });
    svcMgr.addService('Netlogon', 'Netlogon', 'Maintains a secure channel to a domain controller for authentication of users and services',
      { dependencies: ['NTDS'], account: 'NT AUTHORITY\\SYSTEM' });
    svcMgr.addService('Kdc', 'Kerberos Key Distribution Center', 'Issues session tickets and temporary session keys used in the Windows Kerberos SSO scheme',
      { dependencies: ['NTDS'], account: 'NT AUTHORITY\\SYSTEM' });
  }

  /** Minimal SYSVOL: real DC promotion auto-shares `C:\Windows\SYSVOL\sysvol\<domain>` as `\\<dc>\SYSVOL` (Domain Admins-writable, everyone-readable) — no GPO/FRS/DFSR replication content, per PRD §2.2 scope. */
  private provisionSysvol(domainName: string): void {
    const path = `C:\\Windows\\SYSVOL\\sysvol\\${domainName}`;
    this.getFileSystem().mkdirp(path);
    this.smbShares.add('SYSVOL', path, {
      description: 'Logon server share',
      permissions: new Map([['Everyone', 'Read'], ['Domain Admins', 'Full']]),
    });
  }
}

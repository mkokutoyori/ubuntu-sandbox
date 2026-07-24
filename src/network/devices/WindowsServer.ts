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
import { DfsNamespaceRegistry } from './windows/server/dfs/DfsNamespace';
import { WindowsDfsrRole } from './windows/server/dfs/DfsReplicationGroup';
import { ClusterService, type ClusterPeerConfig } from './windows/server/cluster/ClusterService';
import { WindowsWsusRole } from './windows/server/wsus/WsusRole';
import { WindowsPrintServerRole } from './windows/server/print/PrintServerRole';
import { randomSessionKey } from '@/network/kerberos/crypto';
import { dialLdap } from './windows/server/ad/ldap/LdapClient';
import { pullReplication, notifySyncNow } from './windows/server/ad/replication/ReplicationSession';
import { createForest, joinForestAsChildDomain, getForestForDomain, type Forest } from './windows/server/ad/forest/Forest';
import { getExchangeOrganization, getOrCreateExchangeOrganization, type ExchangeServerRecord } from './windows/server/exchange/ExchangeOrganization';
import { MailboxStore, type MailboxOpResult, type DeliverResult } from './windows/server/exchange/MailboxStore';
import { DistributionGroupStore, deliverExpanded, type DistributionGroupOpResult, type DistributionGroupType } from './windows/server/exchange/DistributionGroupStore';
import { buildGlobalAddressList, resolveGalRecipient, type GalEntry } from './windows/server/exchange/GlobalAddressList';
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
  private dfsNamespaceRoleInstance: DfsNamespaceRegistry | null = null;
  private dfsrRoleInstance: WindowsDfsrRole | null = null;
  private clusterServiceInstance: ClusterService | null = null;
  private wsusRoleInstance: WindowsWsusRole | null = null;
  private printServerRoleInstance: WindowsPrintServerRole | null = null;
  private exchangeOrgName: string | null = null;

  constructor(name: string = 'WinServer', x: number = 0, y: number = 0) {
    super('windows-server', name, x, y);
    // Real Windows Server has no built-in non-admin "User" account — setup
    // (OOBE) only creates/activates the local Administrator, who is the
    // account logged in by default. WindowsPC's 'User' default is correct
    // for a client SKU but wrong here, so override it post-construction.
    this.getUserManager().setCurrentUser('Administrator');
  }

  override getWindowsEdition(): 'client' | 'server' { return 'server'; }

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
      this.npsRoleInstance = new WindowsNpsRole(this, this, this.eventLog, () => this.simulatedDate(), () => this.getBus());
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
      this.iisRoleInstance = new WindowsIisRole(this, this.getFileSystem(), this.getCertStore());
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
      this.adcsRoleInstance = new WindowsAdcsRole(() => this.simulatedDate().getTime(), this.getBus(), this.getHostname());
    }
    return this.adcsRoleInstance;
  }

  /**
   * PRD Phase 16 (§5 P16): DFS Namespaces — `New-DfsnRoot`/`New-DfsnFolder`
   * build a logical path redirecting to real `smbShares` targets (§5 P3)
   * — null while the `FS-DFS-Namespace` role isn't installed.
   */
  getDfsNamespaceRole(): DfsNamespaceRegistry | null {
    if (!this.roleManager.isInstalled('FS-DFS-Namespace')) {
      this.dfsNamespaceRoleInstance = null;
      return null;
    }
    if (!this.dfsNamespaceRoleInstance) this.dfsNamespaceRoleInstance = new DfsNamespaceRegistry();
    return this.dfsNamespaceRoleInstance;
  }

  /**
   * PRD Phase 16 (§5 P16): DFSR — this server's own membership across
   * every replication group it's part of; `null` while the
   * `FS-DFS-Replication` role isn't installed (also gates the TCP/5722
   * listener registered in `WindowsPC.initDefaultSockets`).
   */
  getDfsrRole(): WindowsDfsrRole | null {
    if (!this.roleManager.isInstalled('FS-DFS-Replication')) {
      this.dfsrRoleInstance = null;
      return null;
    }
    if (!this.dfsrRoleInstance) this.dfsrRoleInstance = new WindowsDfsrRole(this, this.getFileSystem(), this.getBus(), this.getHostname());
    return this.dfsrRoleInstance;
  }

  /**
   * PRD Phase 18 (§5 P18): this server's own membership in the WSFC cluster
   * it was formed into via `newCluster` — `null` until that has succeeded
   * (also gates/tears down on `Failover-Clustering` role uninstall, mirroring
   * the DFSR/AD CS role getters above). Unlike those roles, a bare install
   * of the feature doesn't lazily create a cluster membership: `New-Cluster`
   * must actually run first, since membership requires cluster-specific
   * parameters (name, peers) no lazy default could supply.
   */
  getClusterRole(): ClusterService | null {
    if (!this.roleManager.isInstalled('Failover-Clustering')) {
      if (this.clusterServiceInstance) { this.clusterServiceInstance.stop(); this.clusterServiceInstance = null; }
      return null;
    }
    return this.clusterServiceInstance;
  }

  /**
   * `New-Cluster -Name <clusterName> -Node <selfNodeName>,<peer1>,...` — run
   * identically on every participating node (same convention as
   * `New-DfsReplicationGroup`, §5 P16): each node builds its own
   * `ClusterService`, learning peer liveness purely from real periodic UDP
   * heartbeat traffic (port 3343) — no shared cluster object, no central
   * mediator.
   */
  newCluster(clusterName: string, selfNodeName: string, peers: readonly ClusterPeerConfig[]): AdDsOpResult {
    if (!this.roleManager.isInstalled('Failover-Clustering')) {
      return { ok: false, message: 'New-Cluster : The Failover Clustering feature is not installed on this computer.' };
    }
    if (this.clusterServiceInstance) {
      return { ok: false, message: `New-Cluster : This computer is already a member of cluster "${this.clusterServiceInstance.clusterName}".` };
    }
    this.clusterServiceInstance = new ClusterService(this, clusterName, selfNodeName, peers, () => this.getScheduler(), this.getBus());
    this.clusterServiceInstance.start();
    return { ok: true, message: '' };
  }

  /**
   * PRD Phase 19 (§5 P19): the WSUS role, `WsusService` — null while the
   * `UpdateServices` role isn't installed. Purely local business logic (no
   * network listener config beyond the always-open TCP/8530 registered in
   * `WindowsPC.initDefaultSockets`, gated on this getter like DFSR/RDP).
   */
  getWsusRole(): WindowsWsusRole | null {
    if (!this.roleManager.isInstalled('UpdateServices')) {
      this.wsusRoleInstance = null;
      return null;
    }
    if (!this.wsusRoleInstance) this.wsusRoleInstance = new WindowsWsusRole();
    return this.wsusRoleInstance;
  }

  /**
   * PRD Phase 20 (§5 P20): the Print and Document Services role's shared
   * queues — null while `Print-Services` isn't installed (also gates the
   * TCP/515 LPD listener registered in `WindowsPC.initDefaultSockets`).
   * `Print-Services` itself was already part of the base PRD's role
   * catalog (§5 P2) since `LanmanServer`-style built-in services ship on
   * every SKU; this phase is the first to actually attach a role object.
   */
  getPrintServerRole(): WindowsPrintServerRole | null {
    if (!this.roleManager.isInstalled('Print-Services')) {
      this.printServerRoleInstance = null;
      return null;
    }
    if (!this.printServerRoleInstance) this.printServerRoleInstance = new WindowsPrintServerRole();
    return this.printServerRoleInstance;
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
  installADDSForest(domainName: string, netbiosName: string | undefined, safeModeAdminPassword: string, opts: { installDns?: boolean } = {}): AdDsOpResult {
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
    const forest = createForest(domainName, netbios, this.directoryStore.getSchemaValidatorForSharing());
    forest.initializeFsmoRoles(this.getHostname());
    this.directoryStore.initializeDomainFsmoRoles(this.getHostname());
    this.provisionSysvol(domainName);
    this.registerDcServices();
    if (opts.installDns !== false) this.roleManager.install('DNS');
    this.provisionDomainDnsZone(domainName);
    this.provisionDefaultDomainPolicy();
    this.logDirectoryServiceStartup();
    this.auditPolicy.seedDefaults('domain-controller');
    return { ok: true, message: '' };
  }

  /**
   * `Install-ExchangeServer -Roles Mailbox -OrganizationName "..."`
   * (docs/PRD-Exchange.md §2.1 P1) — condenses the real multi-step
   * `setup.exe /mode:Install /role:Mailbox` process (schema extension,
   * domain prep, binary install) into a single cmdlet, mirroring how
   * `installADDSForest` above condenses DC promotion. Requires this
   * server to already be domain-joined (member server or DC) — a real
   * Exchange install extends the AD schema and needs a domain to extend.
   * All servers sharing the same `-OrganizationName` join one shared
   * `ExchangeOrganization` (one org per forest, as in a real deployment).
   */
  installExchangeServer(organizationName: string, roles: readonly string[] = ['Mailbox']): AdDsOpResult {
    if (this.exchangeOrgName !== null) {
      return { ok: false, message: 'Install-ExchangeServer : Setup has already been run on this computer.' };
    }
    if (!this.getDomainMembership() && !this.directoryStore) {
      return { ok: false, message: 'Install-ExchangeServer : This computer must be joined to an Active Directory domain before Exchange Server can be installed.' };
    }
    const org = getOrCreateExchangeOrganization(organizationName);
    org.servers.set(this.getHostname(), { hostname: this.getHostname(), roles: new Set(roles), installedAt: Date.now() });
    this.exchangeOrgName = organizationName;
    return { ok: true, message: '' };
  }

  getExchangeOrganizationName(): string | null { return this.exchangeOrgName; }

  getExchangeServer(hostname?: string): ExchangeServerRecord | null {
    if (this.exchangeOrgName === null) return null;
    const org = getExchangeOrganization(this.exchangeOrgName);
    return org?.servers.get(hostname ?? this.getHostname()) ?? null;
  }

  listExchangeServers(): ExchangeServerRecord[] {
    if (this.exchangeOrgName === null) return [];
    const org = getExchangeOrganization(this.exchangeOrgName);
    return org ? [...org.servers.values()] : [];
  }

  /**
   * `Enable-Mailbox`/`New-Mailbox`/`Get-Mailbox`/`Set-Mailbox`/
   * `Get-MailboxStatistics`/`Disable-Mailbox`/`Remove-Mailbox`
   * (docs/PRD-Exchange.md §2.1 P2) — the `MailboxStore` behind these
   * lives on the shared `ExchangeOrganization`, not per-server, so any
   * server in the org sees the same mailboxes (mirrors how `Get-
   * ExchangeServer` already works, § 2.1 P1).
   */
  getMailboxStore(): MailboxStore | null {
    if (this.exchangeOrgName === null) return null;
    return getExchangeOrganization(this.exchangeOrgName)?.mailboxes ?? null;
  }

  enableMailbox(identity: string): MailboxOpResult {
    const store = this.getMailboxStore();
    if (!store) return { ok: false, message: 'Enable-Mailbox : Exchange Server has not been installed on this computer.' };
    if (!this.directoryStore) return { ok: false, message: 'Enable-Mailbox : This computer is not configured as a domain controller.' };
    const user = this.directoryStore.getUser(identity);
    if (!user) return { ok: false, message: `Enable-Mailbox : The operation couldn't be performed because object '${identity}' couldn't be found.` };
    return store.enable(user.sam, `${user.sam}@${this.directoryStore.dnsName}`);
  }

  newMailbox(sam: string, password: string): MailboxOpResult {
    const store = this.getMailboxStore();
    if (!store) return { ok: false, message: 'New-Mailbox : Exchange Server has not been installed on this computer.' };
    if (!this.directoryStore) return { ok: false, message: 'New-Mailbox : This computer is not configured as a domain controller.' };
    const userRes = this.directoryStore.newUser(sam, { password });
    if (!userRes.ok) return { ok: false, message: `New-Mailbox : ${userRes.message}` };
    return store.enable(sam, `${sam}@${this.directoryStore.dnsName}`);
  }

  disableMailbox(identity: string): MailboxOpResult {
    const store = this.getMailboxStore();
    if (!store) return { ok: false, message: 'Disable-Mailbox : Exchange Server has not been installed on this computer.' };
    const sam = this.directoryStore?.resolveIdentity(identity) ?? identity;
    return store.disable(sam);
  }

  removeMailbox(identity: string): MailboxOpResult {
    const disableRes = this.disableMailbox(identity);
    if (!disableRes.ok) return disableRes;
    const removeRes = this.directoryStore?.removeUser(identity);
    if (removeRes && !removeRes.ok) return { ok: false, message: `Remove-Mailbox : ${removeRes.message}` };
    return { ok: true, message: '' };
  }

  /**
   * `New-DistributionGroup`/`Set-DistributionGroup`/`Add-
   * DistributionGroupMember`/`Get-DistributionGroupMember`
   * (docs/PRD-Exchange.md §2.1 P3) — mail-enables an AD group that
   * already carries the matching `GroupCategory` (§ P3-préalable), it
   * never creates the AD group itself (mirrors `Enable-Mailbox`, not
   * `New-Mailbox`, for groups). `-Type Security` mail-enables an
   * existing `Security` group; the default `Distribution` type requires
   * an existing `Distribution` group.
   */
  getDistributionGroupStore(): DistributionGroupStore | null {
    if (this.exchangeOrgName === null) return null;
    return getExchangeOrganization(this.exchangeOrgName)?.distributionGroups ?? null;
  }

  newDistributionGroup(sam: string, type: DistributionGroupType = 'Distribution'): DistributionGroupOpResult {
    const store = this.getDistributionGroupStore();
    if (!store) return { ok: false, message: 'New-DistributionGroup : Exchange Server has not been installed on this computer.' };
    if (!this.directoryStore) return { ok: false, message: 'New-DistributionGroup : This computer is not configured as a domain controller.' };
    const group = this.directoryStore.getGroup(sam);
    if (!group) return { ok: false, message: `New-DistributionGroup : The operation couldn't be performed because object '${sam}' couldn't be found.` };
    const expectedCategory = type === 'SecurityMailEnabled' ? 'Security' : 'Distribution';
    if (group.category !== expectedCategory) {
      return { ok: false, message: `New-DistributionGroup : '${sam}' is a ${group.category} group and cannot be mail-enabled as ${type === 'SecurityMailEnabled' ? 'a mail-enabled security group' : 'a distribution group'}.` };
    }
    return store.mailEnable(group.sam, `${group.sam}@${this.directoryStore.dnsName}`, type);
  }

  setDistributionGroupPrimarySmtpAddress(identity: string, address: string): DistributionGroupOpResult {
    const store = this.getDistributionGroupStore();
    if (!store) return { ok: false, message: 'Set-DistributionGroup : Exchange Server has not been installed on this computer.' };
    return store.setPrimarySmtpAddress(identity, address);
  }

  addDistributionGroupMember(identity: string, memberSam: string): DistributionGroupOpResult {
    const store = this.getDistributionGroupStore();
    if (!store) return { ok: false, message: 'Add-DistributionGroupMember : Exchange Server has not been installed on this computer.' };
    if (!store.get(identity)) return { ok: false, message: `Add-DistributionGroupMember : The operation couldn't be performed because object '${identity}' couldn't be found.` };
    const res = this.directoryStore?.addGroupMember(identity, memberSam);
    if (!res) return { ok: false, message: 'Add-DistributionGroupMember : This computer is not configured as a domain controller.' };
    if (!res.ok) return { ok: false, message: `Add-DistributionGroupMember : ${res.message}` };
    return { ok: true, message: '' };
  }

  getDistributionGroupMembers(identity: string): string[] | null {
    const store = this.getDistributionGroupStore();
    if (!store || !store.get(identity)) return null;
    return this.directoryStore?.getGroup(identity)?.members ?? [];
  }

  /**
   * `Get-GlobalAddressList` (docs/PRD-Exchange.md §2.1 P4) — derived
   * dynamically from the current mailboxes/distribution groups on every
   * call, never a separately maintained copy (a disabled mailbox drops
   * out immediately, no resync step).
   */
  getGlobalAddressList(): GalEntry[] {
    const mailboxStore = this.getMailboxStore();
    const groupStore = this.getDistributionGroupStore();
    if (!mailboxStore || !groupStore) return [];
    return buildGlobalAddressList(mailboxStore, groupStore);
  }

  /**
   * Resolves a `To:` recipient the way a real Exchange/Outlook client
   * does: a literal SMTP address passes through unchanged, anything
   * else (display name/SAM account name) is resolved against the GAL —
   * `null` when the name is unknown or ambiguous (§2.1 P4).
   */
  resolveRecipientAddress(query: string): string | null {
    const resolution = resolveGalRecipient(query, this.getGlobalAddressList());
    if (resolution.kind === 'literal-address') return resolution.address;
    if (resolution.kind === 'resolved') return resolution.entry.primarySmtpAddress;
    return null;
  }

  deliverToRecipient(recipientQuery: string, from: string, subject: string, rawMessage: string, receivedAt: number): DeliverResult[] {
    const groupStore = this.getDistributionGroupStore();
    const mailboxStore = this.getMailboxStore();
    if (!groupStore || !mailboxStore) return [{ delivered: false, reason: 'not-found' }];
    const recipientAddress = this.resolveRecipientAddress(recipientQuery);
    if (recipientAddress === null) return [{ delivered: false, reason: 'not-found' }];
    return deliverExpanded(
      groupStore, mailboxStore,
      (sam) => this.directoryStore?.getGroup(sam)?.members ?? [],
      recipientAddress, from, subject, rawMessage, receivedAt,
    );
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
    opts: { installDns?: boolean } = {},
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
    if (opts.installDns !== false) this.roleManager.install('DNS');
    this.provisionDomainDnsZone(newDomainDnsName);
    this.provisionDefaultDomainPolicy();
    this.logDirectoryServiceStartup();
    return { ok: true, message: '' };
  }

  /** `Get-ADForest` — the forest this domain belongs to, or null if this server isn't a DC. */
  getForest(): Forest | null {
    if (!this.directoryStore) return null;
    return getForestForDomain(this.directoryStore.dnsName);
  }

  /**
   * `Move-ADDirectoryServerOperationMasterRole` — planned transfer (both
   * DCs reachable) and forced seizure (`-Force`, old owner may be gone)
   * are the same underlying operation in this simulator: real AD's only
   * behavioral difference is whether the outgoing owner is asked to
   * finish pending writes first, which this simulator has no queued
   * writes to flush anyway. `targetHostname` may be short or FQDN; roles
   * are matched case-insensitively against the 5 real FSMO role names.
   */
  moveOperationMasterRole(targetHostname: string, roles: string[], _force: boolean): AdDsOpResult {
    if (!this.directoryStore) {
      return { ok: false, message: 'Move-ADDirectoryServerOperationMasterRole : This computer is not a domain controller.' };
    }
    const forest = this.getForest();
    const target = targetHostname.split('.')[0];
    const forestRoles = new Set(['schemamaster', 'domainnamingmaster']);
    const domainRoles = new Set(['ridmaster', 'pdcemulator', 'infrastructuremaster']);
    for (const role of roles) {
      const key = role.toLowerCase().replace(/\s+/g, '');
      if (forestRoles.has(key)) {
        forest?.transferFsmoRole(key === 'schemamaster' ? 'schemaMaster' : 'domainNamingMaster', target);
      } else if (domainRoles.has(key)) {
        const domainRole = key === 'ridmaster' ? 'RIDMaster' : key === 'pdcemulator' ? 'PDCEmulator' : 'InfrastructureMaster';
        this.directoryStore.transferDomainFsmoRole(domainRole, target);
      } else {
        return { ok: false, message: `Move-ADDirectoryServerOperationMasterRole : "${role}" is not a valid operation master role.` };
      }
    }
    return { ok: true, message: '' };
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
    opts: { installDns?: boolean } = {},
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
    if (opts.installDns !== false) this.roleManager.install('DNS');
    this.provisionDomainDnsZone(domainName);
    this.logDirectoryServiceStartup();
    this.auditPolicy.seedDefaults('domain-controller');
    /**
     * Real DCPromo urgently replicates the new DC's own computer object
     * back out (a critical-object push, distinct from the initial sync
     * above) so the rest of the domain learns about it immediately rather
     * than waiting for the source DC's next scheduled cycle. Best-effort:
     * a source DC that doesn't support the push notification (unlikely —
     * this simulator's DCs all do) just stays unaware until it next pulls.
     */
    notifySyncNow(this.getTcpStack(), sourceDcAddress);
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
        complexityEnabled: true, reversibleEncryptionEnabled: false,
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
    const iface = this.getInterfaces().find(p => p.getIPAddress() !== null);
    const ownIp = iface?.getIPAddress() ?? null;
    if (ownIp) {
      dns.addARecord(domainName, hostname, ownIp.toString());
      dns.addARecord(domainName, '@', ownIp.toString());
    }
    const dcTarget = `${hostname}.${domainName}`;
    dns.addSrvRecord(domainName, '_ldap._tcp.dc._msdcs', { priority: 0, weight: 100, port: 389, target: dcTarget });
    dns.addSrvRecord(domainName, '_kerberos._tcp.dc._msdcs', { priority: 0, weight: 100, port: 88, target: dcTarget });
    const mask = iface?.getSubnetMask() ?? null;
    if (ownIp && mask) {
      const octets = ownIp.getOctets();
      const networkOctets = Math.floor(mask.toCIDR() / 8);
      if (networkOctets > 0 && networkOctets < 4) {
        const reverseZone = `${octets.slice(0, networkOctets).reverse().join('.')}.in-addr.arpa`;
        if (!dns.getZone(reverseZone)) {
          dns.addPrimaryZone(reverseZone);
          dns.addPtrRecord(reverseZone, octets.slice(networkOctets).join('.'), dcTarget);
        }
      }
    }
  }

  /** Real DC promotion registers `NTDS`/`Netlogon`/`Kdc`/`ADWS` with the SCM (PRD §5 P6) — `dcdiag`/`nltest` read their state. */
  private registerDcServices(): void {
    const svcMgr = this.getServiceManager();
    svcMgr.addService('NTDS', 'Active Directory Domain Services', 'AD DS Domain Controller service',
      { account: 'NT AUTHORITY\\SYSTEM', processName: 'lsass.exe', binaryPath: 'C:\\Windows\\System32\\lsass.exe' });
    svcMgr.addService('Netlogon', 'Netlogon', 'Maintains a secure channel to a domain controller for authentication of users and services',
      { dependencies: ['NTDS'], account: 'NT AUTHORITY\\SYSTEM' });
    svcMgr.addService('Kdc', 'Kerberos Key Distribution Center', 'Issues session tickets and temporary session keys used in the Windows Kerberos SSO scheme',
      { dependencies: ['NTDS'], account: 'NT AUTHORITY\\SYSTEM' });
    svcMgr.addService('ADWS', 'Active Directory Web Services', 'Provides a web service interface to Active Directory domains',
      { dependencies: ['NTDS'], account: 'NT AUTHORITY\\NETWORK SERVICE', processName: 'Microsoft.ActiveDirectory.WebServices.exe' });
  }

  private logDirectoryServiceStartup(): void {
    this.eventLog.newEventLog('Directory Service', 'NTDS General');
    this.eventLog.writeEventLog(
      'Directory Service', 'NTDS General', 1004, 'Information',
      'Active Directory Domain Services Startup Complete.',
    );
  }

  /** Minimal SYSVOL: real DC promotion auto-shares `C:\Windows\SYSVOL\sysvol\<domain>` as `\\<dc>\SYSVOL`, and `...\<domain>\SCRIPTS` as `\\<dc>\NETLOGON` (both Domain Admins-writable, everyone-readable) — no GPO/FRS/DFSR replication content, per PRD §2.2 scope. */
  private provisionSysvol(domainName: string): void {
    const path = `C:\\Windows\\SYSVOL\\sysvol\\${domainName}`;
    const scriptsPath = `${path}\\SCRIPTS`;
    this.getFileSystem().mkdirp(scriptsPath);
    const permissions = new Map([['Everyone', 'Read'], ['Domain Admins', 'Full']]);
    this.smbShares.add('SYSVOL', path, { description: 'Logon server share', permissions });
    this.smbShares.add('NETLOGON', scriptsPath, { description: 'Logon server share', permissions });
  }
}

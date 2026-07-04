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

export interface AdDsOpResult { ok: boolean; message: string }

export class WindowsServer extends WindowsPC {
  private readonly roleManager: RoleManager = new RoleManager(this.getServiceManager());
  private directoryStore: DirectoryStore | null = null;
  private dnsServerRoleInstance: WindowsDnsServerRole | null = null;
  private dhcpServerRoleInstance: WindowsDhcpServerRole | null = null;
  private npsRoleInstance: WindowsNpsRole | null = null;

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
    this.provisionSysvol(domainName);
    this.registerDcServices();
    this.provisionDomainDnsZone(domainName);
    this.provisionDefaultDomainPolicy();
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

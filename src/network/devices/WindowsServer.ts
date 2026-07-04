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

export interface AdDsOpResult { ok: boolean; message: string }

export class WindowsServer extends WindowsPC {
  private readonly roleManager: RoleManager = new RoleManager(this.getServiceManager());
  private directoryStore: DirectoryStore | null = null;

  constructor(name: string = 'WinServer', x: number = 0, y: number = 0) {
    super('windows-server', name, x, y);
  }

  /** PRD Phase 2 (§5 P2): Server Manager's role/feature model. */
  getRoleManager(): RoleManager { return this.roleManager; }

  /** PRD Phase 5 (§5 P5): the real AD DS directory, once `Install-ADDSForest` has promoted this server. */
  getDirectoryStore(): DirectoryStore | null { return this.directoryStore; }

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
    return { ok: true, message: '' };
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

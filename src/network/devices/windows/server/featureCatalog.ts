/**
 * featureCatalog — Windows Server 2022 feature/role definitions consumed
 * by `RoleManager` (PRD-Windows-Server.md §5 P2, §2.1.2). A deliberate
 * subset: the 7 roles named in the PRD plus the one RSAT tool feature
 * needed by `-IncludeManagementTools`, not the full real-world tree
 * (hundreds of sub-role-services) — see PRD §2.2 non-objectifs.
 *
 * `services` are the WindowsServiceManager entries a feature's install
 * brings up. `FS-FileServer`/`Print-Services` point at services that
 * already exist as OS built-ins (`LanmanServer`/`Spooler`) — installing
 * the role only has to ensure they're running, never create them, since
 * real Windows ships those services on every SKU. The others are
 * role-only services `RoleManager` creates on install and retires on
 * uninstall.
 */

export interface WindowsFeatureDef {
  /** Canonical `Name` column value (e.g. `FS-FileServer`). */
  readonly name: string;
  /** `Display Name` column value (e.g. `File Server`). */
  readonly displayName: string;
  /** What `Get-WindowsFeature` reports in `FeatureType`. */
  readonly featureType: 'Role' | 'Role Service' | 'Feature';
  /** WindowsServiceManager service names this feature's install brings up. */
  readonly services: readonly string[];
  /** PowerShell module the feature unlocks (e.g. `SmbShare`, `DnsServer`). */
  readonly psModule?: string;
  /** Companion tool feature installed when `-IncludeManagementTools` is passed. */
  readonly managementToolsFeature?: string;
  /**
   * Other real Windows feature names that resolve to this same entry —
   * e.g. real admins install ADCS by its actual role-service names
   * (`ADCS-Cert-Authority`/`ADCS-Web-Enrollment`), not the umbrella
   * `AD-Certificate` role name this simulator's minimal catalog tracks
   * install state under (PRD §2.2 non-objectifs: no full role-service
   * tree). Installing under any alias marks the canonical `name` as
   * installed, matching real `Get-WindowsFeature` grouping.
   */
  readonly aliases?: readonly string[];
}

export const WINDOWS_FEATURE_CATALOG: readonly WindowsFeatureDef[] = [
  {
    name: 'FS-FileServer', displayName: 'File Server',
    featureType: 'Role Service',
    services: ['LanmanServer'], psModule: 'SmbShare',
  },
  {
    name: 'AD-Domain-Services', displayName: 'Active Directory Domain Services',
    featureType: 'Role',
    services: ['NTDS', 'Netlogon', 'Kdc'], psModule: 'ActiveDirectory',
    managementToolsFeature: 'RSAT-AD-PowerShell',
  },
  {
    name: 'DNS', displayName: 'DNS Server',
    featureType: 'Role',
    services: ['DNS'], psModule: 'DnsServer',
  },
  {
    name: 'DHCP', displayName: 'DHCP Server',
    featureType: 'Role',
    services: ['DHCPServer'], psModule: 'DhcpServer',
  },
  {
    name: 'NPAS', displayName: 'Network Policy and Access Services',
    featureType: 'Role',
    services: ['IAS'], psModule: 'NPS',
  },
  {
    name: 'Web-Server', displayName: 'Web Server (IIS)',
    featureType: 'Role',
    services: ['W3SVC'], psModule: 'WebAdministration',
  },
  {
    name: 'Print-Services', displayName: 'Print and Document Services',
    featureType: 'Role',
    services: ['Spooler'], psModule: 'PrintManagement',
  },
  {
    name: 'AD-Certificate', displayName: 'Active Directory Certificate Services',
    featureType: 'Role',
    services: ['CertSvc'], psModule: 'ADCSDeployment',
    aliases: ['ADCS-Cert-Authority', 'ADCS-Web-Enrollment'],
  },
  {
    name: 'FS-DFS-Namespace', displayName: 'DFS Namespaces',
    featureType: 'Role Service',
    services: ['Dfs'], psModule: 'DFSN',
  },
  {
    name: 'FS-DFS-Replication', displayName: 'DFS Replication',
    featureType: 'Role Service',
    services: ['DFSR'], psModule: 'DFSR',
  },
  {
    name: 'Failover-Clustering', displayName: 'Failover Clustering',
    featureType: 'Feature',
    services: ['ClusSvc'], psModule: 'FailoverClusters',
  },
  {
    name: 'UpdateServices', displayName: 'Windows Server Update Services',
    featureType: 'Role',
    services: ['WsusService'], psModule: 'UpdateServices',
  },
  {
    name: 'RSAT-AD-PowerShell', displayName: 'Active Directory module for Windows PowerShell',
    featureType: 'Feature',
    services: [], psModule: 'ActiveDirectory',
  },
] as const;

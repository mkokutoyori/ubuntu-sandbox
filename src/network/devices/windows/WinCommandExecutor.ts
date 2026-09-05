/**
 * Windows command executor — context interface and types for modular Windows commands.
 *
 * Each command module (WinIpconfig, WinNetsh, etc.) receives a WinCommandContext
 * that provides access to device internals without tight coupling to WindowsPC.
 */

import { Port } from '../../hardware/Port';
import { IPAddress, MACAddress, SubnetMask } from '../../core/types';
import type { ARPEntry } from '../EndHost';
import type { NetFirewallRuleEntry } from './netFirewallRule';

/** Ping result from EndHost.executePingSequence */
export interface PingResult {
  seq: number;
  success: boolean;
  fromIP?: string;
  ttl: number;
  rttMs: number;
  error?: string;
}

export interface TracerouteProbe {
  responded: boolean;
  rttMs?: number;
  ip?: string;
  unreachable?: boolean;
  icmpCode?: number;
}

/** Traceroute hop from EndHost.executeTraceroute */
export interface TracerouteHop {
  hop: number;
  ip?: string;
  rttMs?: number;
  timeout: boolean;
  unreachable?: boolean;
  icmpCode?: number;
  probes: TracerouteProbe[];
}

/** Route entry from EndHost.getRoutingTable */
export interface RouteEntry {
  network: IPAddress;
  mask: SubnetMask;
  nextHop: IPAddress | null;
  iface: string;
  metric: number;
  type: 'connected' | 'static' | 'default';
}

/**
 * Context provided to all Windows command modules.
 * Abstracts access to EndHost/WindowsPC internals.
 */
export interface WinCommandContext {
  /** Optional event-log provider — `wevtutil qe Security|System|...` reads here. */
  eventLog?: {
    getEntriesStructured: (logName: string, opts?: { newest?: number; entryType?: string; source?: string }) =>
      Array<{
        source: string; eventId: number; message: string;
        index?: number; entryType?: string; timeGenerated?: Date;
        data?: Record<string, string>;
      }> | null;
    /** `wevtutil el` — le vrai registre des journaux. */
    getAllLogsStructured?: () => Array<{ logName: string; entries: number; maxSizeKB: number }>;
    /** `wevtutil gl` / `gli` — configuration et statut d'un journal. */
    getLogStatus?: (logName: string) => {
      logName: string; enabled: boolean; maxSizeKB: number;
      overflow: 'OverwriteOlder' | 'DoNotOverwrite' | 'OverwriteAsNeeded';
      numberOfLogRecords: number; oldestRecordNumber: number;
      fileSize: number; lastWriteTime: Date | null;
    } | null;
    /** `wevtutil sl` — rend `null` en cas de succès, le refus sinon. */
    setLogConfig?: (logName: string, cfg: {
      enabled?: boolean; maxSizeKB?: number; retention?: boolean;
    }) => string | null;
    /** `wevtutil epl` — rend `null` en cas de succès, le refus sinon. */
    exportLog?: (logName: string, destination: string, overwrite: boolean) => string | null;
    /** `wevtutil qe /lf:` — relit un fichier exporté. */
    readExportedLog?: (path: string) => string | null;
    /** `wevtutil al` — rend `null` en cas de succès, le refus sinon. */
    archiveExportedLog?: (path: string) => string | null;
    /** `wevtutil cl` — vide réellement le journal. */
    clearEventLog?: (logName: string) => string;
    /** L'horloge de l'hôte, pour les filtres `timediff`. */
    now?: () => number;
  };
  /** Device hostname */
  hostname: string;
  /** All ports (Map of name → Port) */
  ports: Map<string, Port>;
  /** Default gateway IP string or null */
  defaultGateway: string | null;
  /** IPv6 default gateway string or null (router-advertised or static) */
  defaultGateway6: string | null;
  /** ARP table */
  arpTable: Map<string, ARPEntry>;
  getNeighborCache?: () => Map<string, { mac: MACAddress; iface: string; state: string }>;

  // ARP table mutation
  addStaticARP(ip: IPAddress, mac: MACAddress, iface: string): void;
  deleteARP(ip: IPAddress): boolean;
  clearARPTable(): void;

  // Network config
  configureInterface(ifName: string, ip: IPAddress, mask: SubnetMask): void;
  setDefaultGateway(gw: IPAddress): void;
  clearDefaultGateway(): void;
  addStaticRoute(network: IPAddress, mask: SubnetMask, nextHop: IPAddress, metric: number): boolean;
  removeRoute(dest: IPAddress, mask: SubnetMask): boolean;
  getRoutingTable(): RouteEntry[];

  // DHCP
  isDHCPConfigured(ifName: string): boolean;
  getDHCPState(ifName: string): any;
  releaseLease(ifName: string): string;
  requestLease(ifName: string, opts: any): string;
  autoDiscoverDHCPServers(): void;

  // DHCP event log
  addDHCPEvent(type: string, message: string): void;
  syncDHCPEvents(): void;
  getDHCPEventLog(): string[];

  // Network operations
  /**
   * The interface the IP layer would send this destination out of, and
   * whether the destination sits on that interface's own subnet.
   * `null` means no route at all.
   *
   * Windows decides what to print before the packet leaves: a send that
   * the stack itself refuses reads `PING: transmit failed. General
   * failure.`, which is a different event from a packet that left and
   * drew no answer.
   */
  resolvePingEgress?(target: IPAddress): { port: Port; onLink: boolean } | null;
  executePingSequence(target: IPAddress, count: number, timeout?: number, ttl?: number,
    opts?: { dataSize?: number; df?: boolean }): Promise<PingResult[]>;
  executeTraceroute(target: IPAddress, maxHops?: number, timeoutMs?: number): Promise<TracerouteHop[]>;

  // TCP/IP stack reset
  resetStack(): void;

  // DNS management
  getDnsServers(ifName: string): string[];
  setDnsServers(ifName: string, servers: string[]): void;
  getDnsMode(ifName: string): 'static' | 'dhcp';
  setDnsMode(ifName: string, mode: 'static' | 'dhcp'): void;

  // Interface admin state
  setInterfaceAdmin(ifName: string, enabled: boolean): void;
  getInterfaceAdmin(ifName: string): boolean;

  // IP address removal
  clearInterfaceIP(ifName: string): void;

  // Switch interface to DHCP mode (address source)
  setAddressDhcp(ifName: string): void;

  // DHCP tracing
  getDhcpTraceEnabled(): boolean;
  setDhcpTraceEnabled(enabled: boolean): void;

  // DNS suffix
  getDnsSuffix(): string;
  setDnsSuffix(suffix: string): void;
  getConnectionDnsSuffix(ifName: string): string;

  // Interface renaming
  renameInterface(oldName: string, newName: string): boolean;

  // DHCP class id (option 60 vendor class) — `ipconfig /showclassid|/setclassid`
  getClassId(ifName: string): string | null;
  setClassId(ifName: string, classId: string | null): void;
  // DHCPv6 class id — `ipconfig /showclassid6|/setclassid6`
  getClassId6(ifName: string): string | null;
  setClassId6(ifName: string, classId: string | null): void;

  // IPv6 Router Solicitation — `ipconfig /renew6` re-solicits the
  // on-link router(s) for a fresh SLAAC prefix (no DHCPv6 lease to renew).
  sendRouterSolicitation(ifName: string): void;

  // Hostname resolution. The DNS step queries the configured servers over
  // UDP/53 through the simulated network — hence asynchronous.
  resolveHostname(name: string): Promise<IPAddress | null>;

  reverseLookup?(ip: string): string | null;

  /** IPv4 multicast groups this host has joined (`netsh … show joins`). */
  listMulticastGroups?(ifName?: string): Array<{ iface: string; group: string }>;

  // Service state query (for netsh dhcpclient show state, etc.)
  isServiceRunning(name: string): boolean;

  // Port-proxy rules (netsh interface portproxy)
  portProxy: import('./PortProxyTable').PortProxyTable;

  dnsCache: import('@/network/dns/resolver/DnsCache').DnsCache;

  /**
   * Per-device firewall rule store shared by:
   *   - `netsh advfirewall firewall add/show/delete rule`
   *   - PowerShell `New-NetFirewallRule` / `Get-NetFirewallRule`
   *   - the Windows Filtering Platform packet check
   *     (`firewallFilter()` on WindowsPC)
   * so a rule added through one surface is honoured by the data plane
   * and visible through the other.
   */
  firewallRules: Map<string, NetFirewallRuleEntry>;

  /** Per-device SMB share table (`net share` / `New-SmbShare`) — instance-owned. */
  smbShares: import('./server/smb/SmbShareTable').SmbShareTable;
  /** Per-device `net use` drive-letter mapping table — instance-owned. */
  netUseTable: Map<string, import('./WinNetUse').NetUseEntry>;
  /** Live inbound SMB sessions on this device (`net session`). */
  smbSessions: import('./server/smb/SmbSessionTable').SmbSessionTable;
  /** Dial a remote SMB share over the real network (`net use` add-form). */
  dialSmbShare(targetIp: string, shareName: string, username: string, password: string):
    import('./server/smb/SmbClient').SmbDialResult;

  /** DHCP Server role (PRD-Windows-Server.md §5 P8) — null/undefined unless this is a `WindowsServer` with the `DHCP` feature installed. Backs `netsh dhcp server`. */
  dhcpServerRole?: import('./server/dhcp/WindowsDhcpServerRole').WindowsDhcpServerRole | null;

  /** NPS (RADIUS) role (PRD-Windows-Server.md §5 P9) — null/undefined unless this is a `WindowsServer` with the `NPAS` feature installed. Backs `netsh nps`. */
  npsRole?: import('./server/nps/WindowsNpsRole').WindowsNpsRole | null;
}

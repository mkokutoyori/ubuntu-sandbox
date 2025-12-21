/**
 * Cisco IOS Terminal Types
 * Complete type definitions for Cisco CLI simulation
 */

// CLI Modes - Cisco IOS has multiple command modes
export type CiscoMode =
  | 'user'           // User EXEC mode (Router>)
  | 'privileged'     // Privileged EXEC mode (Router#)
  | 'global-config'  // Global configuration mode (Router(config)#)
  | 'interface'      // Interface configuration mode (Router(config-if)#)
  | 'line'           // Line configuration mode (Router(config-line)#)
  | 'router'         // Router configuration mode (Router(config-router)#)
  | 'vlan'           // VLAN configuration mode (Switch(config-vlan)#)
  | 'dhcp'           // DHCP pool configuration mode
  | 'acl'            // Access list configuration mode
  | 'route-map'      // Route-map configuration mode
  | 'subinterface';  // Subinterface configuration mode

// Interface types
export type CiscoInterfaceType =
  | 'FastEthernet'
  | 'GigabitEthernet'
  | 'TenGigabitEthernet'
  | 'Serial'
  | 'Loopback'
  | 'Vlan'
  | 'Tunnel'
  | 'Port-channel';

// Interface configuration
export interface CiscoInterface {
  name: string;                    // e.g., "GigabitEthernet0/0"
  type: CiscoInterfaceType;
  slot: number;
  port: number;
  subinterface?: number;           // For subinterfaces like Gi0/0.10
  description?: string;
  ipAddress?: string;
  subnetMask?: string;
  secondaryIPs?: { ip: string; mask: string }[];
  macAddress: string;
  isUp: boolean;
  isAdminDown: boolean;            // shutdown command
  speed: 'auto' | '10' | '100' | '1000' | '10000';
  duplex: 'auto' | 'full' | 'half';
  mtu: number;
  bandwidth: number;               // in Kbps
  delay: number;                   // in microseconds

  // Layer 2 (Switch) settings
  switchportMode?: 'access' | 'trunk' | 'dynamic-auto' | 'dynamic-desirable';
  accessVlan?: number;
  nativeVlan?: number;
  allowedVlans?: string;           // "1-100,200,300-400" or "all"
  voiceVlan?: number;

  // Port security
  portSecurity?: {
    enabled: boolean;
    maximum: number;
    violation: 'protect' | 'restrict' | 'shutdown';
    macAddresses: string[];
    sticky: boolean;
  };

  // Spanning Tree
  stpPortfast?: boolean;
  stpBpduguard?: boolean;
  stpCost?: number;
  stpPriority?: number;

  // Layer 3 settings
  ipHelper?: string[];             // DHCP relay
  ospfCost?: number;
  ospfPriority?: number;
  ospfNetwork?: 'broadcast' | 'point-to-point' | 'non-broadcast';

  // Statistics
  inputPackets: number;
  outputPackets: number;
  inputErrors: number;
  outputErrors: number;
  collisions: number;
  lastInput: Date | null;
  lastOutput: Date | null;
}

// VLAN configuration
export interface VlanConfig {
  id: number;
  name: string;
  state: 'active' | 'suspend';
  shutdown: boolean;
  mtu: number;
  ports: string[];
}

// Routing table entry
export interface CiscoRoute {
  protocol: 'C' | 'S' | 'R' | 'O' | 'D' | 'B' | 'i' | 'L';  // Connected, Static, RIP, OSPF, EIGRP, BGP, IS-IS, Local
  network: string;
  mask: string;
  nextHop?: string;
  interface?: string;
  metric?: number;
  administrativeDistance: number;
  age?: string;
  tag?: number;
}

// ARP table entry
export interface CiscoARPEntry {
  protocol: 'Internet';
  address: string;
  age: number;          // minutes, - for incomplete
  hardwareAddr: string;
  type: 'ARPA';
  interface: string;
}

// MAC address table entry (switches)
export interface CiscoMACEntry {
  vlan: number;
  macAddress: string;
  type: 'DYNAMIC' | 'STATIC';
  ports: string;
}

// OSPF neighbor
export interface OSPFNeighbor {
  neighborId: string;
  priority: number;
  state: 'FULL' | '2WAY' | 'INIT' | 'DOWN' | 'EXSTART' | 'EXCHANGE' | 'LOADING';
  deadTime: string;
  address: string;
  interface: string;
}

// OSPF configuration
export interface OSPFConfig {
  processId: number;
  routerId?: string;
  networks: { network: string; wildcardMask: string; area: number }[];
  passiveInterfaces: string[];
  defaultInformationOriginate: boolean;
  redistributeStatic: boolean;
  redistributeConnected: boolean;
}

// EIGRP configuration
export interface EIGRPConfig {
  asNumber: number;
  routerId?: string;
  networks: string[];
  passiveInterfaces: string[];
  autoSummary: boolean;
}

// RIP configuration
export interface RIPConfig {
  version: 1 | 2;
  networks: string[];
  passiveInterfaces: string[];
  autoSummary: boolean;
  defaultInformationOriginate: boolean;
}

// DHCP Pool configuration
export interface DHCPPool {
  name: string;
  network?: string;
  mask?: string;
  defaultRouter?: string[];
  dnsServer?: string[];
  domain?: string;
  leaseTime?: { days: number; hours: number; minutes: number };
  excludedAddresses: { start: string; end?: string }[];
}

// ACL configuration
export interface ACLEntry {
  sequence: number;
  action: 'permit' | 'deny';
  protocol: 'ip' | 'tcp' | 'udp' | 'icmp' | 'any' | number;
  sourceIP: string;
  sourceWildcard: string;
  sourcePort?: { operator: 'eq' | 'lt' | 'gt' | 'range'; ports: number[] };
  destIP: string;
  destWildcard: string;
  destPort?: { operator: 'eq' | 'lt' | 'gt' | 'range'; ports: number[] };
  established?: boolean;
  log?: boolean;
}

export interface AccessList {
  number?: number;           // Standard (1-99, 1300-1999) or Extended (100-199, 2000-2699)
  name?: string;             // Named ACL
  type: 'standard' | 'extended';
  entries: ACLEntry[];
}

// NAT configuration
export interface NATConfig {
  insideInterfaces: string[];
  outsideInterfaces: string[];
  staticNAT: { inside: string; outside: string }[];
  poolNAT: { name: string; startIP: string; endIP: string; mask: string }[];
  overload?: { aclNumber: number; interface: string };
}

// Line configuration (console, vty, aux)
export interface LineConfig {
  type: 'console' | 'vty' | 'aux';
  startLine: number;
  endLine?: number;
  password?: string;
  login: boolean;
  loginLocal: boolean;
  execTimeout: { minutes: number; seconds: number };
  transportInput?: ('telnet' | 'ssh' | 'all' | 'none')[];
  transportOutput?: ('telnet' | 'ssh' | 'all' | 'none')[];
  loggingSynchronous: boolean;
}

// Banner configuration
export interface BannerConfig {
  motd?: string;
  login?: string;
  exec?: string;
}

// Terminal state
export interface CiscoTerminalState {
  hostname: string;
  mode: CiscoMode;
  currentInterface?: string;
  currentLine?: { type: 'console' | 'vty' | 'aux'; start: number; end?: number };
  currentRouter?: { protocol: 'ospf' | 'eigrp' | 'rip' | 'bgp'; id: number };
  currentVlan?: number;
  currentACL?: string | number;
  currentDHCPPool?: string;
  currentRouteMap?: string;

  // Enable mode authentication
  enableSecret?: string;
  enablePassword?: string;
  isAuthenticated: boolean;

  // Terminal settings
  terminalLength: number;
  terminalWidth: number;

  // Command history
  history: string[];
  historyIndex: number;

  // Configuration modified flag
  configModified: boolean;
}

// Output line
export interface CiscoOutputLine {
  id: string;
  type: 'input' | 'output' | 'error' | 'system';
  content: string;
  timestamp: Date;
  prompt?: string;
}

// Command result
export interface CiscoCommandResult {
  output: string;
  error?: string;
  exitCode: number;
  newMode?: CiscoMode;
  newInterface?: string;
  newLine?: { type: 'console' | 'vty' | 'aux'; start: number; end?: number };
  newRouter?: { protocol: 'ospf' | 'eigrp' | 'rip' | 'bgp'; id: number };
  newVlan?: number;
  newACL?: string | number;
  newDHCPPool?: string;
  clearScreen?: boolean;
  moreOutput?: boolean;
}

// Real device data from NetworkStack (for integration with live simulation)
export interface RealDeviceData {
  interfaces: Array<{
    id: string;
    name: string;
    type: string;
    macAddress: string;
    ipAddress?: string;
    subnetMask?: string;
    isUp: boolean;
  }>;
  routingTable: Array<{
    destination: string;
    netmask: string;
    gateway: string;
    interface: string;
    metric: number;
    protocol: string;
  }>;
  arpTable: Array<{
    ipAddress: string;
    macAddress: string;
    interface: string;
    age?: number;
  }>;
  macTable?: Array<{
    vlan: number;
    macAddress: string;
    type: string;
    ports: string;
  }>;
  natTranslations?: Array<{
    insideLocal: string;
    insideGlobal: string;
    outsideLocal: string;
    outsideGlobal: string;
    protocol?: number;
    insidePort?: number;
    outsidePort?: number;
    type: 'static' | 'dynamic' | 'pat';
  }>;
  aclList?: Array<{
    identifier: number | string;
    type: 'standard' | 'extended';
    entries: Array<{
      sequence: number;
      action: 'permit' | 'deny';
      source: string;
      destination?: string;
      protocol?: string;
      hits: number;
    }>;
  }>;
}

// Device type (Router vs Switch)
export type CiscoDeviceType = 'router' | 'switch';

// Complete Cisco device configuration
export interface CiscoConfig {
  deviceType: CiscoDeviceType;
  hostname: string;
  domainName?: string;

  // Security
  enableSecret?: string;
  enablePassword?: string;
  username: { name: string; privilege: number; secret: string }[];
  servicePasswordEncryption: boolean;

  // Interfaces
  interfaces: Map<string, CiscoInterface>;

  // VLANs (mainly for switches)
  vlans: Map<number, VlanConfig>;
  vtpMode?: 'server' | 'client' | 'transparent' | 'off';
  vtpDomain?: string;

  // Routing
  ipRouting: boolean;
  staticRoutes: CiscoRoute[];
  ospf?: OSPFConfig;
  eigrp?: EIGRPConfig;
  rip?: RIPConfig;
  defaultGateway?: string;  // For switches

  // Tables
  arpTable: CiscoARPEntry[];
  macTable: CiscoMACEntry[];  // For switches

  // Services
  dhcpPools: Map<string, DHCPPool>;
  dhcpExcluded: { start: string; end?: string }[];

  // Security
  accessLists: Map<string | number, AccessList>;
  nat?: NATConfig;

  // Lines
  lineConsole: LineConfig;
  lineVty: LineConfig[];
  lineAux?: LineConfig;

  // Banners
  banners: BannerConfig;

  // Spanning Tree (switches)
  stpMode?: 'pvst' | 'rapid-pvst' | 'mst';
  stpPriority?: { vlan: number; priority: number }[];

  // CDP/LLDP
  cdpEnabled: boolean;
  lldpEnabled: boolean;

  // Logging
  loggingBuffered: boolean;
  loggingConsole: boolean;
  loggingLevel: number;

  // NTP
  ntpServer?: string[];

  // DNS
  ipDomainLookup: boolean;
  nameServers: string[];
}

// Helper function to create default interface
export function createDefaultInterface(
  name: string,
  type: CiscoInterfaceType,
  slot: number,
  port: number
): CiscoInterface {
  return {
    name,
    type,
    slot,
    port,
    macAddress: generateCiscoMAC(),
    isUp: false,
    isAdminDown: true,
    speed: 'auto',
    duplex: 'auto',
    mtu: 1500,
    bandwidth: type === 'GigabitEthernet' ? 1000000 : type === 'FastEthernet' ? 100000 : 1544,
    delay: type.includes('Ethernet') ? 10 : 20000,
    inputPackets: 0,
    outputPackets: 0,
    inputErrors: 0,
    outputErrors: 0,
    collisions: 0,
    lastInput: null,
    lastOutput: null,
  };
}

// Generate Cisco-style MAC address
export function generateCiscoMAC(): string {
  const hexDigits = '0123456789abcdef';
  // Cisco OUI prefixes
  const ciscoOUIs = ['0000.0c', '0001.42', '0001.43', '0001.63', '0001.64'];
  let mac = ciscoOUIs[Math.floor(Math.random() * ciscoOUIs.length)];
  for (let i = 0; i < 6; i++) {
    if (i % 2 === 0 && i > 0) mac += '.';
    mac += hexDigits[Math.floor(Math.random() * 16)];
  }
  return mac;
}

// Format MAC address in Cisco style (xxxx.xxxx.xxxx)
export function formatCiscoMAC(mac: string): string {
  const clean = mac.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  if (clean.length !== 12) return mac;
  return `${clean.slice(0, 4)}.${clean.slice(4, 8)}.${clean.slice(8, 12)}`;
}

// Parse interface name into components
export function parseInterfaceName(name: string): { type: string; slot: number; port: number; subinterface?: number } | null {
  // Handle abbreviated names
  const fullName = expandInterfaceName(name);

  const match = fullName.match(/^([A-Za-z-]+)(\d+)\/(\d+)(?:\.(\d+))?$/);
  if (!match) {
    // Try loopback format
    const loopbackMatch = fullName.match(/^Loopback(\d+)$/i);
    if (loopbackMatch) {
      return { type: 'Loopback', slot: 0, port: parseInt(loopbackMatch[1]) };
    }
    // Try VLAN format
    const vlanMatch = fullName.match(/^Vlan(\d+)$/i);
    if (vlanMatch) {
      return { type: 'Vlan', slot: 0, port: parseInt(vlanMatch[1]) };
    }
    return null;
  }

  return {
    type: match[1],
    slot: parseInt(match[2]),
    port: parseInt(match[3]),
    subinterface: match[4] ? parseInt(match[4]) : undefined,
  };
}

// Expand abbreviated interface name
export function expandInterfaceName(name: string): string {
  const abbreviations: Record<string, string> = {
    'gi': 'GigabitEthernet',
    'gig': 'GigabitEthernet',
    'fa': 'FastEthernet',
    'fas': 'FastEthernet',
    'eth': 'Ethernet',
    'se': 'Serial',
    'ser': 'Serial',
    'lo': 'Loopback',
    'loop': 'Loopback',
    'vl': 'Vlan',
    'vlan': 'Vlan',
    'tu': 'Tunnel',
    'tun': 'Tunnel',
    'po': 'Port-channel',
    'port': 'Port-channel',
    'te': 'TenGigabitEthernet',
    'tengig': 'TenGigabitEthernet',
  };

  const match = name.match(/^([a-zA-Z-]+)([\d\/\.]+)?$/);
  if (!match) return name;

  const prefix = match[1].toLowerCase();
  const suffix = match[2] || '';

  return (abbreviations[prefix] || match[1]) + suffix;
}

// Calculate wildcard mask from subnet mask
export function subnetToWildcard(subnetMask: string): string {
  const octets = subnetMask.split('.').map(Number);
  return octets.map(o => 255 - o).join('.');
}

// Calculate subnet mask from CIDR prefix
export function prefixToSubnetMask(prefix: number): string {
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return [
    (mask >>> 24) & 255,
    (mask >>> 16) & 255,
    (mask >>> 8) & 255,
    mask & 255
  ].join('.');
}

// Calculate CIDR prefix from subnet mask
export function subnetMaskToPrefix(mask: string): number {
  const octets = mask.split('.').map(Number);
  const binary = octets.map(o => o.toString(2).padStart(8, '0')).join('');
  return binary.split('1').length - 1;
}

// Check if IP is in network
export function isIPInNetwork(ip: string, network: string, wildcardMask: string): boolean {
  const ipOctets = ip.split('.').map(Number);
  const networkOctets = network.split('.').map(Number);
  const wildcardOctets = wildcardMask.split('.').map(Number);

  for (let i = 0; i < 4; i++) {
    const mask = 255 - wildcardOctets[i];
    if ((ipOctets[i] & mask) !== (networkOctets[i] & mask)) {
      return false;
    }
  }
  return true;
}

// Generate unique ID
export function generateId(): string {
  return Math.random().toString(36).substr(2, 9);
}

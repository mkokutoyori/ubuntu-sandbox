/**
 * DHCP Protocol Types (RFC 2131, RFC 2132)
 *
 * Defines all types for DHCP client/server state machines,
 * pool configuration, lease management, and packet structures.
 */

// ─── DHCP Client States (RFC 2131 §4.4) ──────────────────────────────

export type DHCPClientState =
  | 'INIT'
  | 'SELECTING'
  | 'REQUESTING'
  | 'BOUND'
  | 'RENEWING'
  | 'REBINDING'
  | 'INIT-REBOOT'
  | 'REBOOTING';

// ─── DHCP Message Types (RFC 2132 §9.6) ──────────────────────────────

export type DHCPMessageType =
  | 'DHCPDISCOVER'
  | 'DHCPOFFER'
  | 'DHCPREQUEST'
  | 'DHCPDECLINE'
  | 'DHCPACK'
  | 'DHCPNAK'
  | 'DHCPRELEASE'
  | 'DHCPINFORM';

// ─── DHCP Pool Configuration ─────────────────────────────────────────

export interface DHCPPoolConfig {
  /** Pool name identifier */
  name: string;
  /** Network address (e.g. 192.168.1.0) */
  network: string | null;
  /** Subnet mask (e.g. 255.255.255.0) */
  mask: string | null;
  /** Default gateway address(es) */
  defaultRouter: string | null;
  /** DNS server address(es) */
  dnsServers: string[];
  /** Domain name */
  domainName: string | null;
  /** Lease duration in seconds (default: 86400 = 1 day) */
  leaseDuration: number;
  /** Client-identifier deny patterns */
  denyPatterns: string[];
  /** Option 58: T1 renewal time in seconds (default: 50% of lease) */
  renewalTime?: number;
  /** Option 59: T2 rebinding time in seconds (default: 87.5% of lease) */
  rebindingTime?: number;
}

// ─── DHCP Message Parameters (RFC 2131 §2, RFC 2132) ────────────────

/** Parameters sent in DHCPDISCOVER (client → server) */
export interface DHCPDiscoverParams {
  clientMAC: string;
  xid: number;
  /** Option 61: Client Identifier (01 + MAC for Ethernet) */
  clientIdentifier: string;
  /** Option 55: Parameter Request List (option codes client wants) */
  parameterRequestList: number[];
  /** Option 50: Requested IP (used in INIT-REBOOT) */
  requestedIP?: string;
}

/** Result returned by server for DHCPOFFER */
export interface DHCPOfferResult {
  ip: string;
  pool: DHCPPoolConfig;
  /** Option 54: Server Identifier */
  serverIdentifier: string;
  /** XID echoed back from DISCOVER */
  xid: number;
  /** Option 58: T1 renewal time in seconds */
  renewalTime?: number;
  /** Option 59: T2 rebinding time in seconds */
  rebindingTime?: number;
}

/** Parameters sent in DHCPREQUEST (client → server) */
export interface DHCPRequestParams {
  clientMAC: string;
  xid: number;
  /** Option 50: Requested IP Address */
  requestedIP: string;
  /** Option 54: Server Identifier (in SELECTING state) */
  serverIdentifier?: string;
  /** Option 61: Client Identifier */
  clientIdentifier: string;
}

/** Result returned by server for DHCPACK */
export interface DHCPAckResult {
  binding: DHCPBinding;
  /** Option 54: Server Identifier */
  serverIdentifier: string;
  /** XID echoed back */
  xid: number;
  /** Option 58: T1 renewal time in seconds */
  renewalTime?: number;
  /** Option 59: T2 rebinding time in seconds */
  rebindingTime?: number;
}

/** Parameters sent in DHCPRELEASE (client → server) */
export interface DHCPReleaseParams {
  clientMAC: string;
  /** ciaddr: client's current IP */
  clientIP: string;
  /** Option 54: Server Identifier */
  serverIdentifier?: string;
  /** Option 61: Client Identifier */
  clientIdentifier: string;
}

/** Parameters sent in DHCPDECLINE (client → server) */
export interface DHCPDeclineParams {
  clientMAC: string;
  /** The IP address being declined */
  declinedIP: string;
  /** Option 54: Server Identifier */
  serverIdentifier?: string;
  /** Option 61: Client Identifier */
  clientIdentifier: string;
}

/** Pending offer (reserved IP between DISCOVER and REQUEST) */
export interface DHCPPendingOffer {
  ip: string;
  clientMAC: string;
  poolName: string;
  /** When this offer expires (ms timestamp) */
  expiresAt: number;
}

// ─── DHCP Excluded Address Range ─────────────────────────────────────

export interface DHCPExcludedRange {
  start: string;
  end: string;
}

// ─── DHCP Lease Binding ──────────────────────────────────────────────

export interface DHCPBinding {
  /** Assigned IP address */
  ipAddress: string;
  /** Client hardware (MAC) address */
  clientId: string;
  /** Lease start timestamp (ms) */
  leaseStart: number;
  /** Lease expiration timestamp (ms) */
  leaseExpiration: number;
  /** Pool name that allocated this binding */
  poolName: string;
  /** Type of binding */
  type: 'automatic' | 'manual';
}

// ─── DHCP Server Statistics ──────────────────────────────────────────

export interface DHCPServerStats {
  totalMemory: number;
  discovers: number;
  offers: number;
  requests: number;
  acks: number;
  naks: number;
  declines: number;
  releases: number;
  informs: number;
}

// ─── DHCP Conflict Entry ─────────────────────────────────────────────

export interface DHCPConflict {
  ipAddress: string;
  detectionMethod: string;
  detectionTime: number;
}

// ─── DHCP Client Lease Info ──────────────────────────────────────────

export interface DHCPClientLease {
  /** Interface this lease is bound to */
  iface: string;
  /** Assigned IP address */
  ipAddress: string;
  /** Subnet mask */
  subnetMask: string;
  /** Default gateway */
  defaultGateway: string | null;
  /** DNS servers */
  dnsServers: string[];
  /** Domain name */
  domainName: string | null;
  /** Server identifier (DHCP server IP) */
  serverIdentifier: string;
  /** Lease start timestamp (ms) */
  leaseStart: number;
  /** Lease duration in seconds */
  leaseDuration: number;
  /** T1 renewal time (50% of lease) */
  renewalTime: number;
  /** T2 rebinding time (87.5% of lease) */
  rebindingTime: number;
  /** Lease expiration timestamp (ms) */
  expiration: number;
  /** Transaction ID */
  xid: number;
}

// ─── DHCP Client Interface State ─────────────────────────────────────

export interface DHCPClientIfaceState {
  /** Current DHCP state machine state */
  state: DHCPClientState;
  /** Current transaction ID */
  xid: number;
  /** Current lease (if any) */
  lease: DHCPClientLease | null;
  /** Last known lease for INIT-REBOOT (persisted across reboots) */
  lastKnownLease: DHCPClientLease | null;
  /** DHCP event log for this interface */
  logs: string[];
  /** Renewal timer handle */
  renewalTimer: ReturnType<typeof setTimeout> | null;
  /** Rebinding timer handle */
  rebindingTimer: ReturnType<typeof setTimeout> | null;
  /** Expiration timer handle */
  expirationTimer: ReturnType<typeof setTimeout> | null;
  /** Whether dhclient process is running */
  processRunning: boolean;
}

// ─── DHCP Debug Flags ────────────────────────────────────────────────

export interface DHCPDebugFlags {
  serverPacket: boolean;
  serverEvents: boolean;
}

// ─── DHCP Relay Configuration ────────────────────────────────────────

export interface DHCPRelayConfig {
  /** Helper addresses per interface */
  helperAddresses: Map<string, string[]>;
  /** Forward protocol UDP ports */
  forwardProtocols: Set<number>;
}

// ─── DHCP Snooping (Switch) ─────────────────────────────────────────

export interface DHCPSnoopingConfig {
  /** Global enable */
  enabled: boolean;
  /** VLANs with snooping enabled */
  vlans: Set<number>;
  /** Trusted ports */
  trustedPorts: Set<string>;
  /** Rate limit per port (packets/sec), 0 = unlimited */
  rateLimits: Map<string, number>;
  /** Verify MAC address in DHCP packets */
  verifyMac: boolean;
}

export interface DHCPSnoopingBinding {
  macAddress: string;
  ipAddress: string;
  lease: number;
  type: string;
  vlan: number;
  port: string;
}

// ─── Helper: Create default pool config ──────────────────────────────

export function createDefaultPoolConfig(name: string): DHCPPoolConfig {
  return {
    name,
    network: null,
    mask: null,
    defaultRouter: null,
    dnsServers: [],
    domainName: null,
    leaseDuration: 86400, // 1 day default
    denyPatterns: [],
  };
}

// ─── Helper: Create default stats ────────────────────────────────────

export function createDefaultStats(): DHCPServerStats {
  return {
    totalMemory: 36028,
    discovers: 0,
    offers: 0,
    requests: 0,
    acks: 0,
    naks: 0,
    declines: 0,
    releases: 0,
    informs: 0,
  };
}

// ─── Helper: Create default snooping config ─────────────────────────

export function createDefaultSnoopingConfig(): DHCPSnoopingConfig {
  return {
    enabled: false,
    vlans: new Set(),
    trustedPorts: new Set(),
    rateLimits: new Map(),
    verifyMac: false,
  };
}

// ─── Helper: Create default client interface state ───────────────────

export function createDefaultClientState(): DHCPClientIfaceState {
  return {
    state: 'INIT',
    xid: Math.floor(Math.random() * 0xFFFFFFFF),
    lease: null,
    lastKnownLease: null,
    logs: [],
    renewalTimer: null,
    rebindingTimer: null,
    expirationTimer: null,
    processRunning: false,
  };
}

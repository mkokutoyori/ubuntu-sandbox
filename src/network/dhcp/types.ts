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
  | 'DHCPINFORM'
  | 'DHCPLEASEQUERY'
  | 'DHCPLEASEUNASSIGNED'
  | 'DHCPLEASEUNKNOWN'
  | 'DHCPLEASEACTIVE'
  | 'DHCPBULKLEASEQUERY'
  | 'DHCPLEASEQUERYDONE';

// ─── DHCP Pool Configuration ─────────────────────────────────────────

export interface DHCPPoolConfig {
  /** Pool name identifier */
  name: string;
  /** Network address (e.g. 192.168.1.0) */
  network: string | null;
  /** Subnet mask (e.g. 255.255.255.0) */
  mask: string | null;
  /** Primary gateway — first entry of `defaultRouters`, option 3 as offered */
  defaultRouter: string | null;
  /** Every address given to `default-router`, in order (IOS takes up to 8) */
  defaultRouters: string[];
  /** DNS server address(es) */
  dnsServers: string[];
  /** Domain name */
  domainName: string | null;
  /** Lease duration in seconds (default: 86400 = 1 day) */
  leaseDuration: number;
  /** Client-identifier deny patterns */
  denyPatterns: string[];
  highUtilizationMark: number;
  lowUtilizationMark: number;
  highUtilizationLog: boolean;
  lowUtilizationLog: boolean;
  active?: boolean;
  /** Option 58: T1 renewal time in seconds (default: 50% of lease) */
  renewalTime?: number;
  /** Option 59: T2 rebinding time in seconds (default: 87.5% of lease) */
  rebindingTime?: number;
  /** Option 66 / siaddr — TFTP/next server (boot) */
  nextServer?: string;
  /** Option 67 — boot filename */
  bootfile?: string;
  /** Option 44 — NetBIOS (WINS) name servers */
  netbiosServers?: string[];
  /** Option 46 — NetBIOS node type (b/p/m/h) */
  netbiosNodeType?: string;
  /** true ⇒ lease never expires (`lease infinite`) */
  leaseInfinite?: boolean;
  conflictTtlSec?: number;
  /** Raw DHCP options configured via `option <code> …` */
  options?: Array<{ code: number; kind: 'ip' | 'ascii' | 'hex'; value: string }>;
  /** Manual single-host reservation pool (Cisco `host`/`hardware-address`/…) */
  manual?: {
    host?: string;
    hostMask?: string;
    hardwareAddress?: string;
    clientIdentifier?: string;
    clientName?: string;
  };
}

// ─── DHCP Message Parameters (RFC 2131 §2, RFC 2132) ────────────────

export interface DhcpIpEmission {
  readonly ttl?: number;
  readonly tos?: number;
}

export interface DhcpClientPersonality {
  readonly alwaysSendsClientIdentifier: boolean;
  readonly parameterRequestList: readonly number[];
  readonly sendsFqdn: boolean;
  readonly optionOrder: readonly number[];
  readonly discoverIntervalsSeconds: readonly number[];
}

/** Parameters sent in DHCPDISCOVER (client → server) */
export interface DhcpClientFqdn {
  /** RFC 4702 §2.1 flags: bit0 S, bit1 O, bit2 E, bit3 N. */
  flags: number;
  name: string;
}

export interface DHCPDiscoverParams {
  clientMAC: string;
  xid: number;
  /** Option 12: the name the client calls itself. */
  hostName?: string;
  /** Option 81: RFC 4702 Client FQDN. */
  clientFqdn?: DhcpClientFqdn;
  /** Option 61: Client Identifier (01 + MAC for Ethernet) */
  clientIdentifier: string;
  /** Option 60: Vendor Class Identifier */
  vendorClass?: string;
  /** RFC 2131 §4.1 BROADCAST flag: ask the server to answer by broadcast. */
  broadcast?: boolean;
  secs?: number;
  relayInformation?: DhcpRelayInformation;
  /** Option 55: Parameter Request List (option codes client wants) */
  parameterRequestList: readonly number[];
  optionOrder?: readonly number[];
  alwaysSendClientIdentifier?: boolean;
  /** Option 50: Requested IP (used in INIT-REBOOT) */
  requestedIP?: string;
  /** Relay agent IP (giaddr) — set by relay agent for remote subnet selection */
  giaddr?: string;
  /** IP of the local (non-relayed) ingress interface — used for subnet-based
   *  pool selection when giaddr is absent (directly-attached client). */
  localGatewayIP?: string;
}

/** Result returned by server for DHCPOFFER */
export interface DHCPOfferResult {
  ip: string;
  pool: DHCPPoolConfig;
  /** Option 54: Server Identifier */
  serverIdentifier: string;
  /** Ethernet source MAC of the frame carrying this OFFER (wire channel only) */
  serverMac?: string;
  /** XID echoed back from DISCOVER */
  xid: number;
  /** Option 58: T1 renewal time in seconds */
  renewalTime?: number;
  /** Option 59: T2 rebinding time in seconds */
  rebindingTime?: number;
  /** Generic/vendor options (43, 150, …) decoded to display strings, keyed by code (wire channel only) */
  vendorOptions?: Record<number, string>;
}

export interface DhcpUnicastTarget {
  readonly ip: string;
  readonly mac: string | null;
}

/** Parameters sent in DHCPREQUEST (client → server) */
export interface DHCPRequestParams {
  clientMAC: string;
  xid: number;
  hostName?: string;
  clientFqdn?: DhcpClientFqdn;
  /** Option 50: Requested IP Address */
  requestedIP: string;
  /** Option 54: Server Identifier (in SELECTING state) */
  serverIdentifier?: string;
  /** Option 61: Client Identifier */
  clientIdentifier: string;
  parameterRequestList?: readonly number[];
  optionOrder?: readonly number[];
  alwaysSendClientIdentifier?: boolean;
  /** Option 60: Vendor Class Identifier */
  vendorClass?: string;
  /** RFC 2131 §4.1 BROADCAST flag: ask the server to answer by broadcast. */
  broadcast?: boolean;
  relayInformation?: DhcpRelayInformation;
  requestState?: 'selecting' | 'init-reboot' | 'renewing';
  hardwareAddress?: string;
  clientIdentifierOption?: string;
  currentAddress?: string;
  unicastTo?: DhcpUnicastTarget;
}

/** Result returned by server for DHCPACK */
export interface DHCPAckResult {
  binding: DHCPBinding;
  /** Option 54: Server Identifier */
  serverIdentifier: string;
  /** Ethernet source MAC of the frame carrying this ACK — see DHCPOfferResult.serverMac. */
  serverMac?: string;
  /** XID echoed back */
  xid: number;
  /** Option 58: T1 renewal time in seconds */
  renewalTime?: number;
  /** Option 59: T2 rebinding time in seconds */
  rebindingTime?: number;
}

export function ackOf(result: DHCPRequestWithNakResult | null): DHCPAckResult | null {
  if (result?.type !== 'ACK' || !result.binding) return null;
  return {
    binding: result.binding, serverIdentifier: result.serverIdentifier, xid: result.xid,
    renewalTime: result.renewalTime, rebindingTime: result.rebindingTime, serverMac: result.serverMac,
  };
}

/** Parameters sent in DHCPRELEASE (client → server) */
export interface DHCPReleaseParams {
  clientMAC: string;
  xid?: number;
  alwaysSendClientIdentifier?: boolean;
  /** ciaddr: client's current IP */
  clientIP: string;
  /** Option 54: Server Identifier */
  serverIdentifier?: string;
  /** Option 61: Client Identifier */
  clientIdentifier: string;
  unicastTo?: DhcpUnicastTarget;
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

/** Parameters sent in DHCPINFORM (client → server) */
export interface DHCPInformParams {
  clientMAC: string;
  /** Client's current IP (ciaddr) */
  clientIP: string;
  xid: number;
  /** Option 61: Client Identifier */
  clientIdentifier: string;
}

/** Result returned by server for DHCPINFORM (ACK without lease) */
export interface DHCPInformResult {
  serverIdentifier: string;
  xid: number;
  mask: string;
  router: string | null;
  dnsServers: string[];
  domainName: string | null;
}

/** Result of processRequestWithNak: either ACK or NAK */
export interface DHCPRequestWithNakResult {
  type: 'ACK' | 'NAK';
  /** Binding (only for ACK) */
  binding?: DHCPBinding;
  /** Server Identifier */
  serverIdentifier: string;
  /** Ethernet source MAC of the frame carrying this reply — see DHCPOfferResult.serverMac. */
  serverMac?: string;
  xid: number;
  /** NAK message (only for NAK) */
  message?: string;
  renewalTime?: number;
  rebindingTime?: number;
}

/** Static binding (manual reservation) */
export interface DHCPStaticBinding {
  clientId: string;
  ipAddress: string;
  poolName: string;
  type: 'manual';
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
  hostName?: string;
  /** Lease start timestamp (ms) */
  leaseStart: number;
  /** Lease expiration timestamp (ms) */
  leaseExpiration: number;
  /** Pool name that allocated this binding */
  poolName: string;
  /** Type of binding */
  type: 'automatic' | 'manual';
  /** chaddr of the client that holds the lease (RFC 4388 query by MAC). */
  hardwareAddress?: string;
  /** Raw option 61 of the client, when it sent one (RFC 4388 query by client identifier). */
  clientIdentifierOption?: string;
  /** Last option 82 received for this lease (RFC 4388 §6.4.2). */
  relayInformation?: DhcpRelayInformation;
  /** Last time the client dealt with the server about this address (ms). */
  lastTransaction?: number;
}

export interface DhcpLeaseQuery {
  readonly giaddr: string;
  readonly ipAddress?: string;
  readonly hardwareAddress?: string;
  readonly clientIdentifier?: string;
  readonly parameterRequestList: readonly number[];
}

export type DhcpLeaseQueryResult =
  | { readonly type: 'DHCPLEASEUNKNOWN' }
  | { readonly type: 'DHCPLEASEUNASSIGNED'; readonly ipAddress: string }
  | {
    readonly type: 'DHCPLEASEACTIVE';
    readonly ipAddress: string;
    readonly hardwareAddress: string;
    readonly clientIdentifierOption?: string;
    readonly relayInformation?: DhcpRelayInformation;
    readonly secondsSinceTransaction: number;
    readonly leaseSecondsLeft: number | null;
    readonly associatedAddresses: readonly string[];
    readonly poolName: string;
  };

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
  /** Ethernet source MAC of the frame that answered (physical NIC, not option 54) */
  serverMac: string | null;
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
  /** Option 66 — TFTP/next server */
  nextServer: string | null;
  /** Option 67 — boot filename */
  bootfileName: string | null;
  /** Option 44 — NetBIOS (WINS) name servers */
  netbiosServers: string[];
  /** Option 46 — NetBIOS node type, decoded to its RFC 2132 byte value */
  netbiosNodeType: number | null;
  /** Generic/vendor options (43, 150, …), keyed by code */
  vendorOptions: Record<number, string>;
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
  /** Renewal timer handle (TimerSet token, Phase 4b2-DHCP). */
  renewalTimer: symbol | null;
  /** Rebinding timer handle (TimerSet token). */
  rebindingTimer: symbol | null;
  /** Expiration timer handle (TimerSet token). */
  expirationTimer: symbol | null;
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
  /** RFC 3046: insert Option 82 when relaying (IOS `ip dhcp relay information option`) */
  informationOption?: boolean;
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
  /** Verify MAC address in DHCP packets — enabled by default on IOS */
  verifyMac: boolean;
  /** RFC 3046 Option 82 insertion on snooped packets */
  informationOption: boolean;
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
    defaultRouters: [],
    dnsServers: [],
    domainName: null,
    leaseDuration: 86400, // 1 day default
    denyPatterns: [],
    highUtilizationMark: 100,
    lowUtilizationMark: 0,
    highUtilizationLog: false,
    lowUtilizationLog: false,
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
    verifyMac: true,
    informationOption: false,
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

export interface DhcpRelayInformation {
  readonly circuitId: string;
  readonly remoteId: string;
}

export interface DhcpAdmissionClient {
  readonly vendorClass?: string;
  readonly relayInformation?: DhcpRelayInformation;
}

export interface DhcpAdmissionPolicy {
  mayServe(clientMAC: string, poolName: string, client?: DhcpAdmissionClient): boolean;
  addressAllowed(ip: string, poolName: string): boolean;
  leaseSeconds(poolName: string, configuredSeconds: number, address?: string): number;
}

export type DhcpBulkState = 1 | 2 | 5;

export interface DhcpBulkQuery {
  readonly hardwareAddress?: string;
  readonly clientIdentifier?: string;
  readonly remoteId?: string;
  readonly relayId?: string;
  readonly queryStartTime?: number;
  readonly queryEndTime?: number;
}

export interface DhcpBulkRecord {
  readonly ipAddress: string;
  readonly state: DhcpBulkState;
  readonly poolName: string;
  readonly hardwareAddress?: string;
  readonly clientIdentifierOption?: string;
  readonly relayInformation?: DhcpRelayInformation;
  readonly lastTransaction?: number;
  readonly leaseStart?: number;
  readonly leaseExpiration?: number;
}

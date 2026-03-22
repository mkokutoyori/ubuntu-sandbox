/**
 * Constants — Centralized repository for all magic numbers and strings
 *
 * Eliminates scattered magic values across the codebase.
 * All values are typed, documented, and grouped by domain.
 */

// ─── Device Types ────────────────────────────────────────────────────

export const DEVICE_TYPES = {
  ROUTER_CISCO: 'router-cisco',
  ROUTER_HUAWEI: 'router-huawei',
  SWITCH_CISCO: 'switch-cisco',
  SWITCH_HUAWEI: 'switch-huawei',
  SWITCH_GENERIC: 'switch-generic',
  HUB: 'hub',
  LINUX_PC: 'linux-pc',
  LINUX_SERVER: 'linux-server',
  WINDOWS_PC: 'windows-pc',
  MAC_PC: 'mac-pc',
} as const;

export type DeviceTypeValue = typeof DEVICE_TYPES[keyof typeof DEVICE_TYPES];

// ─── Port Naming ─────────────────────────────────────────────────────

export const PORT_NAMING = {
  CISCO_ROUTER_PREFIX: 'GigabitEthernet',
  CISCO_SWITCH_PREFIX: 'FastEthernet',
  HUAWEI_ROUTER_PREFIX: 'GE',
  HUAWEI_SWITCH_PREFIX: 'GE',
  LINUX_PREFIX: 'eth',
  WINDOWS_PREFIX: 'Ethernet',
  HUB_PREFIX: 'Port',
} as const;

export const PORT_COUNTS = {
  ROUTER_PORTS: 4,
  SWITCH_PORTS: 8,
  HUB_PORTS: 4,
  HOST_PORTS: 1,
  SERVER_PORTS: 2,
} as const;

// ─── RIP Timers (RFC 2453 §3.8) ─────────────────────────────────────

export const RIP_TIMERS = {
  /** Periodic update interval in ms (30 seconds) */
  UPDATE_INTERVAL_MS: 30_000,
  /** Route timeout in ms (180 seconds = 6× update interval) */
  ROUTE_TIMEOUT_MS: 180_000,
  /** Garbage collection timer in ms (120 seconds = 4× update interval) */
  GARBAGE_COLLECTION_MS: 120_000,
} as const;

// ─── ARP/NDP Timers ──────────────────────────────────────────────────

export const ARP_TIMERS = {
  /** ARP request timeout in ms */
  REQUEST_TIMEOUT_MS: 3_000,
  /** ARP cache entry TTL in ms (4 hours, RFC 1122 §2.3.2.1) */
  CACHE_TTL_MS: 14_400_000,
  /** ARP retry interval in ms */
  RETRY_INTERVAL_MS: 1_000,
  /** Max packet queue size while waiting for ARP */
  MAX_QUEUE_SIZE: 100,
  /** Max queue wait time in ms */
  QUEUE_TIMEOUT_MS: 5_000,
} as const;

export const NDP_TIMERS = {
  /** NDP solicitation timeout in ms */
  SOLICITATION_TIMEOUT_MS: 3_000,
  /** Neighbor cache reachable time in ms (30 seconds, RFC 4861 §6.3.2) */
  REACHABLE_TIME_MS: 30_000,
  /** Retransmit timer in ms (1 second, RFC 4861 §6.3.2) */
  RETRANSMIT_TIMER_MS: 1_000,
} as const;

// ─── ICMP / ICMPv6 ───────────────────────────────────────────────────

export const ICMP_CONSTANTS = {
  /** Default ping timeout in ms */
  PING_TIMEOUT_MS: 5_000,
  /** Default ping count */
  DEFAULT_PING_COUNT: 4,
  /** Default ping interval in ms */
  PING_INTERVAL_MS: 1_000,
  /** Default ping payload size in bytes */
  DEFAULT_PAYLOAD_SIZE: 32,
  /** Traceroute max hops */
  TRACEROUTE_MAX_HOPS: 30,
  /** Traceroute probe timeout in ms */
  TRACEROUTE_TIMEOUT_MS: 3_000,
} as const;

// ─── TTL / Hop Limit ─────────────────────────────────────────────────

export const DEFAULT_TTL = {
  LINUX: 64,
  WINDOWS: 128,
  CISCO: 255,
  HUAWEI: 255,
} as const;

// ─── MTU ─────────────────────────────────────────────────────────────

export const MTU = {
  /** Default MTU for Ethernet (RFC 894) */
  DEFAULT: 1500,
  /** Minimum IPv4 MTU (RFC 791 §3.2) */
  MIN_IPV4: 68,
  /** Minimum IPv6 MTU (RFC 8200 §5) */
  MIN_IPV6: 1280,
  /** Maximum configurable MTU */
  MAX: 9216,
  /** Minimum configurable MTU */
  MIN: 68,
} as const;

// ─── Router Advertisement (RFC 4861 §6.2.1) ─────────────────────────

export const RA_DEFAULTS = {
  /** RA interval in ms (200 seconds) */
  INTERVAL_MS: 200_000,
  /** Default router lifetime in seconds (1800s = 30 minutes) */
  ROUTER_LIFETIME_S: 1800,
  /** Default current hop limit */
  CUR_HOP_LIMIT: 64,
  /** Default valid lifetime for prefixes in seconds (2592000s = 30 days) */
  PREFIX_VALID_LIFETIME_S: 2_592_000,
  /** Default preferred lifetime for prefixes in seconds (604800s = 7 days) */
  PREFIX_PREFERRED_LIFETIME_S: 604_800,
} as const;

// ─── Administrative Distance ─────────────────────────────────────────

export const ADMINISTRATIVE_DISTANCE = {
  CONNECTED: 0,
  STATIC: 1,
  OSPF: 110,
  RIP: 120,
  DEFAULT: 254,
} as const;

// ─── DHCP (RFC 2131, RFC 2132) ───────────────────────────────────────

export const DHCP_CONSTANTS = {
  /** Pending offer timeout in ms */
  PENDING_OFFER_TIMEOUT_MS: 60_000,
  /** Default lease time in seconds (24 hours) */
  DEFAULT_LEASE_TIME_S: 86_400,
  /** T1 renewal ratio (50% of lease) */
  T1_RATIO: 0.5,
  /** T2 rebinding ratio (87.5% of lease) */
  T2_RATIO: 0.875,
} as const;

/** DHCP Option codes (RFC 2132) — centralized for reuse across Server/Client/Packet */
export const DHCP_OPTIONS = {
  PAD: 0,
  SUBNET_MASK: 1,
  ROUTER: 3,
  DNS: 6,
  DOMAIN_NAME: 15,
  INTERFACE_MTU: 26,
  BROADCAST_ADDRESS: 28,
  REQUESTED_IP: 50,
  LEASE_TIME: 51,
  MESSAGE_TYPE: 53,
  SERVER_IDENTIFIER: 54,
  PARAMETER_REQUEST_LIST: 55,
  MESSAGE: 56,
  RENEWAL_TIME: 58,
  REBINDING_TIME: 59,
  CLIENT_IDENTIFIER: 61,
  END: 255,
} as const;

/** DHCP Message Type numeric values (Option 53, RFC 2132 §9.6) */
export const DHCP_MESSAGE_TYPES = {
  DISCOVER: 1,
  OFFER: 2,
  REQUEST: 3,
  DECLINE: 4,
  ACK: 5,
  NAK: 6,
  RELEASE: 7,
  INFORM: 8,
} as const;

// ─── Switch (STP, MAC) ──────────────────────────────────────────────

export const SWITCH_CONSTANTS = {
  /** MAC address table aging time in ms (300 seconds) */
  MAC_AGING_TIME_MS: 300_000,
  /** Maximum MAC address table size */
  MAX_MAC_TABLE_SIZE: 8_192,
  /** STP Hello time in ms */
  STP_HELLO_TIME_MS: 2_000,
  /** STP Max Age in ms */
  STP_MAX_AGE_MS: 20_000,
  /** STP Forward Delay in ms */
  STP_FORWARD_DELAY_MS: 15_000,
} as const;

// ─── Port Security ──────────────────────────────────────────────────

export const PORT_SECURITY_DEFAULTS = {
  /** Default maximum MAC addresses */
  MAX_MAC_ADDRESSES: 1,
  /** Default violation mode */
  VIOLATION_MODE: 'shutdown' as const,
} as const;

// ─── OSPF Constants (RFC 2328) ──────────────────────────────────────

export const OSPF_CONSTANTS = {
  /** Initial SPF throttle delay in ms */
  SPF_THROTTLE_INITIAL_MS: 200,
  /** SPF hold time in ms */
  SPF_THROTTLE_HOLD_MS: 1_000,
  /** Max SPF throttle delay in ms */
  SPF_THROTTLE_MAX_MS: 10_000,
  /** Initial sequence number (RFC 2328 §12.4.4) */
  INITIAL_SEQUENCE_NUMBER: 0x80000001,
  /** Max sequence number (signed 32-bit max) */
  MAX_SEQUENCE_NUMBER: 0x7FFFFFFF,
  /** Infinity metric (RFC 2328 §3) */
  INFINITY_METRIC: 0xFFFF,
  /** Default Hello interval in seconds */
  HELLO_INTERVAL_S: 10,
  /** Default Dead interval in seconds */
  DEAD_INTERVAL_S: 40,
  /** Max LSA age in seconds (RFC 2328 §12.4.1) */
  MAX_AGE_S: 3600,
  /** LS refresh time in seconds */
  LS_REFRESH_TIME_S: 1800,
} as const;

/** OSPF LSA type constants (RFC 2328 §12) */
export const OSPF_LSA_TYPES = {
  ROUTER: 1,
  NETWORK: 2,
  SUMMARY_NETWORK: 3,
  SUMMARY_ASBR: 4,
  AS_EXTERNAL: 5,
  NSSA_EXTERNAL: 7,
} as const;

/** OSPF packet type constants (RFC 2328 §A.3) */
export const OSPF_PACKET_TYPES = {
  HELLO: 1,
  DD: 2,
  LS_REQUEST: 3,
  LS_UPDATE: 4,
  LS_ACK: 5,
} as const;

// ─── IPSec Constants ────────────────────────────────────────────────

export const IPSEC_CONSTANTS = {
  /** Maximum anti-replay window size (RFC 4303) */
  MAX_REPLAY_WINDOW: 1024,
  /** Default anti-replay window size */
  DEFAULT_REPLAY_WINDOW: 64,
  /** ESP overhead (conservative estimate per RFC 4303 field sizes) */
  ESP_OVERHEAD_BASE: 50,
  /** Sequence number max (32-bit overflow) */
  SEQ_NUM_MAX: 0xFFFFFFFF,
  /** Fragment reassembly timeout in ms (RFC 791 recommends 15–120s) */
  FRAG_REASSEMBLY_TIMEOUT_MS: 30_000,
  /** Max concurrent fragment groups (memory guard) */
  MAX_FRAG_GROUPS: 256,
  /** Default path MTU for Ethernet */
  DEFAULT_PATH_MTU: 1500,
  /** Default IKE SA lifetime in seconds (24 hours, RFC 2408) */
  DEFAULT_IKE_SA_LIFETIME_S: 86_400,
  /** Default IPSec SA traffic limit in KB (4608000 KB ≈ 4.4 GB) */
  DEFAULT_SA_LIFETIME_KB: 4_608_000,
  /** Default IKE SA lifetime for IKEv2 in seconds (8 hours) */
  DEFAULT_IKEV2_SA_LIFETIME_S: 28_800,
} as const;

// ─── Multicast Addresses ────────────────────────────────────────────

export const MULTICAST = {
  /** IPv4 broadcast */
  IPV4_BROADCAST: '255.255.255.255',
  /** MAC broadcast */
  MAC_BROADCAST: 'ff:ff:ff:ff:ff:ff',
  /** OSPF AllSPFRouters (224.0.0.5) */
  OSPF_ALL_SPF_ROUTERS: '224.0.0.5',
  /** OSPF AllDRouters (224.0.0.6) */
  OSPF_ALL_DR_ROUTERS: '224.0.0.6',
  /** RIP multicast (224.0.0.9) */
  RIP_MULTICAST: '224.0.0.9',
  /** OSPF multicast MAC prefix */
  OSPF_MULTICAST_MAC_PREFIX: '01:00:5e:00:00:',
} as const;

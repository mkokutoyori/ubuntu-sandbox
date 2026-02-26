/**
 * IPSecTypes — Data structures for IPSec/IKE simulation
 *
 * Covers IKEv1 (ISAKMP), IKEv2, ESP/AH, transform sets,
 * crypto maps, dynamic maps, and SA databases.
 */

// ─── IKEv1 Configuration ─────────────────────────────────────────────

export interface ISAKMPPolicy {
  priority: number;
  encryption: string;  // 'aes', 'aes 256', '3des', 'des'
  hash: string;        // 'sha', 'sha256', 'sha384', 'sha512', 'md5'
  auth: string;        // 'pre-share', 'rsa-sig'
  group: number;       // DH group number
  lifetime: number;    // seconds (default 86400)
}

export interface TransformSet {
  name: string;
  transforms: string[];              // e.g. ['esp-aes', 'esp-sha-hmac']
  mode: 'tunnel' | 'transport';
}

export interface CryptoMapEntry {
  seq: number;
  type: 'ipsec-isakmp';
  peers: string[];                   // configured peer IP addresses
  transformSets: string[];           // transform set names
  aclName: string;
  pfsGroup?: string;                 // e.g. 'group14'
  saLifetimeSeconds?: number;
  ikev2ProfileName?: string;
}

export interface DynamicCryptoMapEntry {
  seq: number;
  transformSets: string[];
  aclName?: string;
  pfsGroup?: string;
}

export interface CryptoMap {
  name: string;
  /** Static entries: seq → entry */
  staticEntries: Map<number, CryptoMapEntry>;
  /** Dynamic map references: seq → dynamic map name */
  dynamicEntries: Map<number, string>;
}

export interface DynamicCryptoMap {
  name: string;
  entries: Map<number, DynamicCryptoMapEntry>;
}

// ─── IKEv2 Configuration ─────────────────────────────────────────────

export interface IKEv2Proposal {
  name: string;
  encryption: string[];  // e.g. ['aes-cbc-128', 'aes-cbc-256', '3des']
  integrity: string[];   // e.g. ['sha256', 'sha384', 'sha512']
  dhGroup: number[];     // e.g. [14, 19, 20]
}

export interface IKEv2Policy {
  priority: string | number;
  proposalNames: string[];
  matchAddressLocal?: string;
}

export interface IKEv2KeyringPeer {
  name: string;
  address: string;       // IP address or 0.0.0.0 for wildcard
  preSharedKey: string;
}

export interface IKEv2Keyring {
  name: string;
  peers: Map<string, IKEv2KeyringPeer>;  // key: peer name
}

export interface IKEv2Profile {
  name: string;
  matchIdentityRemoteAddress?: string;  // IP to match
  matchIdentityRemoteAny?: boolean;
  authLocal: string;   // 'pre-share'
  authRemote: string;  // 'pre-share'
  keyringName?: string;
  keyringLocalName?: string;
}

// ─── IPSec Profile (for GRE over IPSec) ─────────────────────────────

export interface IPSecProfile {
  name: string;
  transformSetName: string;
  mode: 'tunnel' | 'transport';
  saLifetimeSeconds?: number;
}

// ─── IKE SA Database ─────────────────────────────────────────────────

export type IKESAStatus =
  | 'MM_NO_STATE'
  | 'MM_SA_SETUP'
  | 'MM_KEY_EXCH'
  | 'MM_KEY_AUTH'
  | 'QM_IDLE'
  | 'AM_ACTIVE';

export interface IKE_SA {
  peerIP: string;
  localIP: string;
  status: IKESAStatus;
  encryption: string;
  hash: string;
  group: number;
  lifetime: number;
  created: number;       // timestamp ms
  spi: string;           // hex string e.g. '0x1234ABCD'
  role: 'initiator' | 'responder';
  natT: boolean;         // NAT-T detected
  dpdEnabled: boolean;
}

export interface IKEv2_SA {
  peerIP: string;
  localIP: string;
  status: 'READY' | 'DELETED';
  spiLocal: string;
  spiRemote: string;
  role: 'Initiator' | 'Responder';
  proposalUsed: string;
  encryptionUsed: string;
  integrityUsed: string;
  dhGroupUsed: number;
  created: number;
  natT: boolean;
}

// ─── IPSec SA Database ────────────────────────────────────────────────

export interface IPSec_SA {
  peerIP: string;
  localIP: string;
  spiIn: number;           // SPI for inbound packets (from peer to me)
  spiOut: number;          // SPI for outbound packets (from me to peer)
  transforms: string[];
  mode: 'Tunnel' | 'Transport';
  aclName: string;
  pktsEncaps: number;      // packets encrypted (outbound)
  pktsDecaps: number;      // packets decrypted (inbound)
  sendErrors: number;
  recvErrors: number;
  created: number;
  lifetime: number;        // seconds
  pfsGroup?: string;
  natT: boolean;
  outIface: string;        // outgoing interface name
  hasESP: boolean;
  hasAH: boolean;
}

// ─── DPD / NAT-T Config ──────────────────────────────────────────────

export interface DPDConfig {
  interval: number;    // seconds
  retries: number;
  mode: 'periodic' | 'on-demand';
}

// ─── Tunnel Protection (for GRE over IPSec) ──────────────────────────

export interface TunnelProtection {
  profileName: string;
  shared: boolean;
}

import type { NetworkPdu } from '@/network/core/NetworkPdu';
import { md5, utf8ToBytes, bytesToHex } from '@/crypto';
export const ETHERTYPE_VTP = 0x2003;
export const VTP_MULTICAST_MAC = '01:00:0c:cc:cc:cc';

/** Real Summary Advertisement's Management Domain field: a fixed 32-byte,
 *  zero-padded slot (Wireshark's `packet-vtp.c` dissector). */
const VTP_DOMAIN_FIELD_BYTES = 32;

function domainField(domain: string): Uint8Array {
  const field = new Uint8Array(VTP_DOMAIN_FIELD_BYTES);
  field.set(utf8ToBytes(domain).slice(0, VTP_DOMAIN_FIELD_BYTES));
  return field;
}

function revisionField(revision: number): Uint8Array {
  const field = new Uint8Array(4);
  field[0] = (revision >>> 24) & 0xff;
  field[1] = (revision >>> 16) & 0xff;
  field[2] = (revision >>> 8) & 0xff;
  field[3] = revision & 0xff;
  return field;
}

export type VtpMode = 'server' | 'client' | 'transparent' | 'off';
export type VtpVersion = 1 | 2 | 3;
export type VtpMessageType = 'summary' | 'subset' | 'request' | 'join';

export interface VtpVlanEntry {
  id: number;
  name: string;
  mtu: number;
  type: 'ethernet';
}

/** v3 only: which independently-revisioned database a summary/subset frame
 *  carries. Absent (or 'vlan') is today's standard VLAN database. */
export type VtpDatabase = 'vlan' | 'mst';

/** Wire shape of an MST region config (`docs/PRD-STP.md §4`'s `MstRegion`,
 *  with its `instances: Map<number, string>` flattened to tuples). */
export interface VtpMstRegionPayload {
  name: string;
  revision: number;
  instances: [number, string][];
}

export interface VtpFrame extends NetworkPdu {
  type: 'vtp';
  version: VtpVersion;
  messageType: VtpMessageType;
  /** Present only on a v3 MST-database summary/subset; `revision` below is
   *  then that database's own counter, independent of the VLAN database's. */
  database?: VtpDatabase;
  domain: string;
  revision: number;
  /** Updater Identity — the IP of whoever last changed the shared VLAN
   *  database (real Cisco: the management interface, or failing that the
   *  lowest-numbered active VLAN SVI). Distinct from `VtpConfig.updaterMac`,
   *  which is the sending device's own fixed chassis ID ("Device ID" in
   *  `show vtp status`) and never travels on the wire. */
  updater: string;
  /** Epoch ms of the last revision increment this frame reflects. */
  updateTimestamp: number;
  /** Summary only: how many Subset Advertisements follow it. */
  followers?: number;
  /** Subset only: 1-based position among `followers` — a receiver buffers
   *  every fragment for a given domain/revision and only applies the VLAN
   *  diff once all of them have arrived (real VTP's own reassembly rule). */
  sequenceNumber?: number;
  vlans: VtpVlanEntry[];
  /** Subset only, `database === 'mst'`: the MST region being synced. */
  mstRegion?: VtpMstRegionPayload;
  interestVlans?: number[];
  primaryClaim?: { updater: string; revision: number; forced: boolean };
  passwordHash: string;
}

export interface VtpConfig {
  enabled: boolean;
  domain: string;
  password: string;
  mode: VtpMode;
  version: VtpVersion;
  revision: number;
  pruning: boolean;
  /** Local device's own fixed MAC — "Device ID" in `show vtp status`.
   *  Never overwritten by a peer's advertisement. */
  updaterMac: string;
  /** IP of whoever last changed the shared VLAN database — local
   *  (stamped from `vtpUpdaterIdentity()` on a local change) or learned
   *  (copied from an accepted Summary/Subset's `updater` field). */
  lastUpdaterIdentity: string;
  /** Epoch ms paired with `lastUpdaterIdentity`. */
  lastUpdateTimestamp: number;
  primaryServer: boolean;
  /** v3 only: independent revision counter for the MST database, distinct
   *  from both `revision` (the VLAN database's) and `MstRegion.revision`
   *  (the operator-set MST config revision, transported as data). */
  mstDatabaseRevision: number;
}

export function createDefaultVtpConfig(systemMac: string): VtpConfig {
  return {
    enabled: true,
    domain: '',
    password: '',
    mode: 'server',
    version: 1,
    revision: 0,
    pruning: false,
    updaterMac: systemMac.toLowerCase(),
    lastUpdaterIdentity: '0.0.0.0',
    lastUpdateTimestamp: 0,
    primaryServer: false,
    mstDatabaseRevision: 0,
  };
}

/**
 * Real Cisco VTP MD5 digest construction, reverse-engineered by the Yersinia
 * VTP packet-crafting tool (`vtp_generate_md5()`): the password's own MD5
 * digest bookends a summary struct (here: the 32-byte zero-padded domain
 * field + the 4-byte big-endian revision), and the whole thing is hashed
 * again — not the domain/password string concatenation this used to be.
 * `version`/`updater`/`vlans` are part of Yersinia's real struct too but
 * aren't included here: no byte serialization for a VLAN database or an
 * IPv4 updater identity exists anywhere else in this codebase to reuse, so
 * pulling them in would mean inventing a second, unverified encoding on
 * top of an already-uncertain one. domain/revision/password (this PRD
 * phase's explicit scope) are the fields every call site already has in a
 * form that matches the real wire field 1:1.
 */
export function hashPassword(domain: string, password: string, revision: number = 0): string {
  if (!password) return '';
  const secret = md5(utf8ToBytes(password));
  const body = new Uint8Array(secret.length + VTP_DOMAIN_FIELD_BYTES + 4 + secret.length);
  let offset = 0;
  body.set(secret, offset); offset += secret.length;
  body.set(domainField(domain), offset); offset += VTP_DOMAIN_FIELD_BYTES;
  body.set(revisionField(revision), offset); offset += 4;
  body.set(secret, offset);
  return bytesToHex(md5(body));
}

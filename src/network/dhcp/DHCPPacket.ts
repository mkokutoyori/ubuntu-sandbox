/**
 * DHCPPacket - Binary DHCP Packet Structure (RFC 2131, RFC 2132)
 *
 * Represents a DHCP packet with fixed header fields and variable-length
 * options. Supports serialization to/from Uint8Array for wire format.
 *
 * Fixed header (236 bytes):
 *   op(1) htype(1) hlen(1) hops(1) xid(4) secs(2) flags(2)
 *   ciaddr(4) yiaddr(4) siaddr(4) giaddr(4) chaddr(16) sname(64) file(128)
 *
 * Options area: magic cookie (4 bytes) + TLV options + end(0xFF)
 */

import type { DHCPMessageType } from './types';
import type { NetworkPdu } from '@/network/core/NetworkPdu';

/** DHCP Option codes (RFC 2132) */
export const DHCP_OPTION = {
  SUBNET_MASK: 1,
  ROUTER: 3,
  DNS: 6,
  HOST_NAME: 12,
  DOMAIN_NAME: 15,
  NETBIOS_NAME_SERVER: 44,
  NETBIOS_NODE_TYPE: 46,
  REQUESTED_IP: 50,
  LEASE_TIME: 51,
  MESSAGE_TYPE: 53,
  SERVER_IDENTIFIER: 54,
  PARAMETER_REQUEST_LIST: 55,
  MESSAGE: 56,
  RENEWAL_TIME: 58,
  REBINDING_TIME: 59,
  CLIENT_IDENTIFIER: 61,
  TFTP_SERVER_NAME: 66,
  BOOTFILE_NAME: 67,
  CLIENT_FQDN: 81,
  END: 255,
  PAD: 0,
} as const;

/** RFC 2132 §8.7 NetBIOS node-type byte values, keyed by Cisco's `X-node` CLI spelling. */
const NETBIOS_NODE_TYPE_VALUES: Record<string, number> = {
  'b-node': 1, 'b': 1,
  'p-node': 2, 'p': 2,
  'm-node': 4, 'm': 4,
  'h-node': 8, 'h': 8,
};

/** Converts either CLI spelling ("h-node") or an already-numeric string ("8") to its byte value. */
export function encodeNetbiosNodeType(nodeType: string): number | undefined {
  const known = NETBIOS_NODE_TYPE_VALUES[nodeType.toLowerCase()];
  if (known !== undefined) return known;
  const n = parseInt(nodeType, 10);
  return Number.isFinite(n) ? n : undefined;
}

const RAW_OPTION_KIND_TAG: Record<'ip' | 'ascii' | 'hex', number> = { ip: 0, ascii: 1, hex: 2 };
const RAW_OPTION_KIND_BY_TAG: Array<'ip' | 'ascii' | 'hex'> = ['ip', 'ascii', 'hex'];

/**
 * Encode a CLI-configured raw `option <code> {ip|ascii|hex} <value>` to wire
 * bytes. Arbitrary vendor options (43, 150, …) are opaque by nature in real
 * DHCP too (RFC 2132 leaves option 43's payload vendor-defined) — a leading
 * kind tag byte is how this simulator's own receiver stays self-describing
 * without hardcoding per-code knowledge of every vendor's convention.
 */
function encodeRawOption(kind: 'ip' | 'ascii' | 'hex', value: string): Uint8Array {
  let body: number[];
  if (kind === 'ip') {
    body = value.trim().split(/\s+/).flatMap(ip => ip.split('.').map(Number));
  } else if (kind === 'hex') {
    const clean = value.replace(/[^0-9a-fA-F]/g, '');
    body = [];
    for (let i = 0; i < clean.length; i += 2) body.push(parseInt(clean.slice(i, i + 2), 16));
  } else {
    body = Array.from(value, ch => ch.charCodeAt(0));
  }
  return Uint8Array.from([RAW_OPTION_KIND_TAG[kind], ...body]);
}

/** Inverse of encodeRawOption — decode wire bytes back to a display string. */
function decodeRawOption(bytes: Uint8Array): string {
  const kind = RAW_OPTION_KIND_BY_TAG[bytes[0]] ?? 'hex';
  const body = bytes.slice(1);
  if (kind === 'ip') {
    const ips: string[] = [];
    for (let i = 0; i + 4 <= body.length; i += 4) ips.push(Array.from(body.slice(i, i + 4)).join('.'));
    return ips.join(' ');
  }
  if (kind === 'hex') {
    return Array.from(body, b => b.toString(16).padStart(2, '0')).join('');
  }
  return Array.from(body, b => String.fromCharCode(b)).join('');
}

/** DHCP Message Type values (Option 53) */
const MESSAGE_TYPE_VALUES: Record<number, DHCPMessageType> = {
  1: 'DHCPDISCOVER',
  2: 'DHCPOFFER',
  3: 'DHCPREQUEST',
  4: 'DHCPDECLINE',
  5: 'DHCPACK',
  6: 'DHCPNAK',
  7: 'DHCPRELEASE',
  8: 'DHCPINFORM',
};

/** Magic cookie (RFC 2131 §3): 99.130.83.99 = 0x63825363 */
const MAGIC_COOKIE = [99, 130, 83, 99];

/** Offer options passed to factory methods */
interface OfferOptions {
  mask: string;
  router: string;
  dns: string[];
  leaseDuration: number;
  renewalTime?: number;
  rebindingTime?: number;
  domainName?: string;
  /** Option 66 — TFTP/next-server (Cisco `next-server`) */
  nextServer?: string;
  /** Option 67 — boot filename (Cisco `bootfile`) */
  bootfile?: string;
  /** Option 44 — NetBIOS (WINS) name servers */
  netbiosServers?: string[];
  /** Option 46 — NetBIOS node type (`b-node`/`p-node`/`m-node`/`h-node`) */
  netbiosNodeType?: string;
  /** Raw `option <code> {ip|ascii|hex} <value>` entries (43, 150, …) */
  rawOptions?: Array<{ code: number; kind: 'ip' | 'ascii' | 'hex'; value: string }>;
}

export class DHCPPacket implements NetworkPdu {
  /** PDU discriminator (NetworkPdu). */
  readonly type = 'dhcp';

  // ─── Fixed Header Fields ──────────────────────────────────────

  /** Message op code: 1 = BOOTREQUEST, 2 = BOOTREPLY */
  op: number = 1;
  /** Hardware address type: 1 = Ethernet */
  htype: number = 1;
  /** Hardware address length: 6 for Ethernet */
  hlen: number = 6;
  /** Relay agent hops */
  hops: number = 0;
  /** Transaction ID */
  xid: number = 0;
  /** Seconds since client began address acquisition */
  secs: number = 0;
  /** Flags (bit 0 = broadcast) */
  flags: number = 0;
  /** Client IP address (only if client is in BOUND/RENEW/REBIND) */
  ciaddr: string = '0.0.0.0';
  /** "Your" (client) IP address assigned by server */
  yiaddr: string = '0.0.0.0';
  /** Server IP address */
  siaddr: string = '0.0.0.0';
  /** Relay agent IP address */
  giaddr: string = '0.0.0.0';
  /** Client hardware address */
  chaddr: string = '00:00:00:00:00:00';

  // ─── Options (TLV) ───────────────────────────────────────────

  private options: Map<number, unknown> = new Map();

  // ─── Option Access ────────────────────────────────────────────

  getOption(code: number): unknown {
    return this.options.get(code);
  }

  /** All option codes set on this packet. */
  getOptionCodes(): number[] {
    return Array.from(this.options.keys());
  }

  /** Decode a raw vendor/generic option's bytes back to its configured display string. */
  static decodeVendorOption(bytes: Uint8Array): string {
    return decodeRawOption(bytes);
  }

  setOption(code: number, value: unknown): void {
    this.options.set(code, value);
  }

  removeOption(code: number): void {
    this.options.delete(code);
  }

  /** Get DHCP message type name from Option 53 */
  getMessageType(): DHCPMessageType | undefined {
    const code = this.options.get(DHCP_OPTION.MESSAGE_TYPE) as number | undefined;
    return code !== undefined ? MESSAGE_TYPE_VALUES[code] : undefined;
  }

  // ─── Factory Methods ──────────────────────────────────────────

  static createDiscover(mac: string, xid: number): DHCPPacket {
    const pkt = new DHCPPacket();
    pkt.op = 1;
    pkt.xid = xid;
    pkt.flags = 0x8000; // Broadcast
    pkt.chaddr = mac.toUpperCase();
    pkt.setOption(DHCP_OPTION.MESSAGE_TYPE, 1); // DHCPDISCOVER
    return pkt;
  }

  static createOffer(
    mac: string, xid: number,
    offeredIP: string, serverIP: string,
    opts: OfferOptions,
  ): DHCPPacket {
    const pkt = new DHCPPacket();
    pkt.op = 2; // BOOTREPLY
    pkt.xid = xid;
    pkt.yiaddr = offeredIP;
    pkt.siaddr = serverIP;
    pkt.chaddr = mac.toUpperCase();
    pkt.setOption(DHCP_OPTION.MESSAGE_TYPE, 2); // DHCPOFFER
    pkt.setOption(DHCP_OPTION.SERVER_IDENTIFIER, serverIP);
    pkt.setOption(DHCP_OPTION.SUBNET_MASK, opts.mask);
    pkt.setOption(DHCP_OPTION.ROUTER, opts.router);
    if (opts.dns.length > 0) pkt.setOption(DHCP_OPTION.DNS, opts.dns);
    pkt.setOption(DHCP_OPTION.LEASE_TIME, opts.leaseDuration);
    if (opts.renewalTime !== undefined) pkt.setOption(DHCP_OPTION.RENEWAL_TIME, opts.renewalTime);
    if (opts.rebindingTime !== undefined) pkt.setOption(DHCP_OPTION.REBINDING_TIME, opts.rebindingTime);
    if (opts.domainName) pkt.setOption(DHCP_OPTION.DOMAIN_NAME, opts.domainName);
    DHCPPacket.applyExtendedOptions(pkt, opts);
    return pkt;
  }

  private static applyExtendedOptions(pkt: DHCPPacket, opts: OfferOptions): void {
    if (opts.nextServer) pkt.setOption(DHCP_OPTION.TFTP_SERVER_NAME, opts.nextServer);
    if (opts.bootfile) pkt.setOption(DHCP_OPTION.BOOTFILE_NAME, opts.bootfile);
    if (opts.netbiosServers && opts.netbiosServers.length > 0) {
      pkt.setOption(DHCP_OPTION.NETBIOS_NAME_SERVER, opts.netbiosServers);
    }
    if (opts.netbiosNodeType) {
      const encoded = encodeNetbiosNodeType(opts.netbiosNodeType);
      if (encoded !== undefined) pkt.setOption(DHCP_OPTION.NETBIOS_NODE_TYPE, encoded);
    }
    for (const raw of opts.rawOptions ?? []) {
      pkt.setOption(raw.code, encodeRawOption(raw.kind, raw.value));
    }
  }

  static createRequest(
    mac: string, xid: number,
    requestedIP: string, serverIP: string,
  ): DHCPPacket {
    const pkt = new DHCPPacket();
    pkt.op = 1;
    pkt.xid = xid;
    pkt.flags = 0x8000;
    pkt.chaddr = mac.toUpperCase();
    pkt.setOption(DHCP_OPTION.MESSAGE_TYPE, 3); // DHCPREQUEST
    pkt.setOption(DHCP_OPTION.REQUESTED_IP, requestedIP);
    pkt.setOption(DHCP_OPTION.SERVER_IDENTIFIER, serverIP);
    return pkt;
  }

  static createAck(
    mac: string, xid: number,
    assignedIP: string, serverIP: string,
    opts: OfferOptions,
  ): DHCPPacket {
    const pkt = new DHCPPacket();
    pkt.op = 2;
    pkt.xid = xid;
    pkt.yiaddr = assignedIP;
    pkt.siaddr = serverIP;
    pkt.chaddr = mac.toUpperCase();
    pkt.setOption(DHCP_OPTION.MESSAGE_TYPE, 5); // DHCPACK
    pkt.setOption(DHCP_OPTION.SERVER_IDENTIFIER, serverIP);
    pkt.setOption(DHCP_OPTION.SUBNET_MASK, opts.mask);
    pkt.setOption(DHCP_OPTION.ROUTER, opts.router);
    if (opts.dns.length > 0) pkt.setOption(DHCP_OPTION.DNS, opts.dns);
    pkt.setOption(DHCP_OPTION.LEASE_TIME, opts.leaseDuration);
    if (opts.renewalTime !== undefined) pkt.setOption(DHCP_OPTION.RENEWAL_TIME, opts.renewalTime);
    if (opts.rebindingTime !== undefined) pkt.setOption(DHCP_OPTION.REBINDING_TIME, opts.rebindingTime);
    if (opts.domainName) pkt.setOption(DHCP_OPTION.DOMAIN_NAME, opts.domainName);
    DHCPPacket.applyExtendedOptions(pkt, opts);
    return pkt;
  }

  static createNak(
    mac: string, xid: number,
    serverIP: string, message: string,
  ): DHCPPacket {
    const pkt = new DHCPPacket();
    pkt.op = 2;
    pkt.xid = xid;
    pkt.chaddr = mac.toUpperCase();
    pkt.setOption(DHCP_OPTION.MESSAGE_TYPE, 6); // DHCPNAK
    pkt.setOption(DHCP_OPTION.SERVER_IDENTIFIER, serverIP);
    pkt.setOption(DHCP_OPTION.MESSAGE, message);
    return pkt;
  }

  static createDecline(
    mac: string, xid: number,
    declinedIP: string, serverIP: string,
  ): DHCPPacket {
    const pkt = new DHCPPacket();
    pkt.op = 1;
    pkt.xid = xid;
    pkt.chaddr = mac.toUpperCase();
    pkt.setOption(DHCP_OPTION.MESSAGE_TYPE, 4); // DHCPDECLINE
    pkt.setOption(DHCP_OPTION.REQUESTED_IP, declinedIP);
    pkt.setOption(DHCP_OPTION.SERVER_IDENTIFIER, serverIP);
    return pkt;
  }

  static createRelease(
    mac: string, xid: number,
    clientIP: string, serverIP: string,
  ): DHCPPacket {
    const pkt = new DHCPPacket();
    pkt.op = 1;
    pkt.xid = xid;
    pkt.ciaddr = clientIP;
    pkt.chaddr = mac.toUpperCase();
    pkt.setOption(DHCP_OPTION.MESSAGE_TYPE, 7); // DHCPRELEASE
    pkt.setOption(DHCP_OPTION.SERVER_IDENTIFIER, serverIP);
    return pkt;
  }

  static createInform(
    mac: string, xid: number,
    clientIP: string,
  ): DHCPPacket {
    const pkt = new DHCPPacket();
    pkt.op = 1;
    pkt.xid = xid;
    pkt.ciaddr = clientIP;
    pkt.chaddr = mac.toUpperCase();
    pkt.setOption(DHCP_OPTION.MESSAGE_TYPE, 8); // DHCPINFORM
    return pkt;
  }

  // ─── Serialization ────────────────────────────────────────────

  /** Serialize packet to binary Uint8Array (wire format) */
  serialize(): Uint8Array {
    const buf = new Uint8Array(576); // Minimum DHCP packet size
    let offset = 0;

    // Fixed header
    buf[offset++] = this.op;
    buf[offset++] = this.htype;
    buf[offset++] = this.hlen;
    buf[offset++] = this.hops;

    // xid (4 bytes big-endian)
    buf[offset++] = (this.xid >>> 24) & 0xFF;
    buf[offset++] = (this.xid >>> 16) & 0xFF;
    buf[offset++] = (this.xid >>> 8) & 0xFF;
    buf[offset++] = this.xid & 0xFF;

    // secs (2 bytes)
    buf[offset++] = (this.secs >>> 8) & 0xFF;
    buf[offset++] = this.secs & 0xFF;

    // flags (2 bytes)
    buf[offset++] = (this.flags >>> 8) & 0xFF;
    buf[offset++] = this.flags & 0xFF;

    // ciaddr, yiaddr, siaddr, giaddr (4 bytes each)
    this.writeIP(buf, offset, this.ciaddr); offset += 4;
    this.writeIP(buf, offset, this.yiaddr); offset += 4;
    this.writeIP(buf, offset, this.siaddr); offset += 4;
    this.writeIP(buf, offset, this.giaddr); offset += 4;

    // chaddr (16 bytes, zero-padded)
    const macBytes = this.chaddr.split(':').map(h => parseInt(h, 16));
    for (let i = 0; i < 16; i++) {
      buf[offset++] = macBytes[i] || 0;
    }

    // sname (64 bytes) + file (128 bytes) = 192 bytes of zeros
    offset += 192;

    // Magic cookie
    buf[offset++] = MAGIC_COOKIE[0];
    buf[offset++] = MAGIC_COOKIE[1];
    buf[offset++] = MAGIC_COOKIE[2];
    buf[offset++] = MAGIC_COOKIE[3];

    // Options
    for (const [code, value] of this.options) {
      offset = this.writeOption(buf, offset, code, value);
    }

    // End option
    buf[offset++] = DHCP_OPTION.END;

    return buf;
  }

  /** Deserialize binary Uint8Array to DHCPPacket */
  static deserialize(data: Uint8Array): DHCPPacket {
    const pkt = new DHCPPacket();
    let offset = 0;

    pkt.op = data[offset++];
    pkt.htype = data[offset++];
    pkt.hlen = data[offset++];
    pkt.hops = data[offset++];

    pkt.xid = ((data[offset] << 24) | (data[offset + 1] << 16) |
               (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
    offset += 4;

    pkt.secs = (data[offset] << 8) | data[offset + 1];
    offset += 2;

    pkt.flags = (data[offset] << 8) | data[offset + 1];
    offset += 2;

    pkt.ciaddr = DHCPPacket.readIP(data, offset); offset += 4;
    pkt.yiaddr = DHCPPacket.readIP(data, offset); offset += 4;
    pkt.siaddr = DHCPPacket.readIP(data, offset); offset += 4;
    pkt.giaddr = DHCPPacket.readIP(data, offset); offset += 4;

    // chaddr
    const macParts: string[] = [];
    for (let i = 0; i < 6; i++) {
      macParts.push(data[offset + i].toString(16).padStart(2, '0').toUpperCase());
    }
    pkt.chaddr = macParts.join(':');
    offset += 16;

    // Skip sname + file
    offset += 192;

    // Verify magic cookie
    if (data[offset] !== 99 || data[offset + 1] !== 130 ||
        data[offset + 2] !== 83 || data[offset + 3] !== 99) {
      throw new Error('Invalid DHCP magic cookie');
    }
    offset += 4;

    // Parse options
    while (offset < data.length) {
      const code = data[offset++];
      if (code === DHCP_OPTION.END) break;
      if (code === DHCP_OPTION.PAD) continue;

      const len = data[offset++];
      const optData = data.slice(offset, offset + len);
      offset += len;

      pkt.options.set(code, DHCPPacket.parseOption(code, optData));
    }

    return pkt;
  }

  // ─── Internal Helpers ─────────────────────────────────────────

  private writeIP(buf: Uint8Array, offset: number, ip: string): void {
    const parts = ip.split('.').map(Number);
    buf[offset] = parts[0];
    buf[offset + 1] = parts[1];
    buf[offset + 2] = parts[2];
    buf[offset + 3] = parts[3];
  }

  private static readIP(data: Uint8Array, offset: number): string {
    return `${data[offset]}.${data[offset + 1]}.${data[offset + 2]}.${data[offset + 3]}`;
  }

  private writeOption(buf: Uint8Array, offset: number, code: number, value: unknown): number {
    buf[offset++] = code;

    switch (code) {
      case DHCP_OPTION.MESSAGE_TYPE: {
        buf[offset++] = 1; // length
        buf[offset++] = value as number;
        break;
      }
      case DHCP_OPTION.SUBNET_MASK:
      case DHCP_OPTION.ROUTER:
      case DHCP_OPTION.SERVER_IDENTIFIER:
      case DHCP_OPTION.REQUESTED_IP: {
        buf[offset++] = 4;
        this.writeIP(buf, offset, value as string);
        offset += 4;
        break;
      }
      case DHCP_OPTION.DNS:
      case DHCP_OPTION.NETBIOS_NAME_SERVER: {
        const servers = value as string[];
        buf[offset++] = servers.length * 4;
        for (const server of servers) {
          this.writeIP(buf, offset, server);
          offset += 4;
        }
        break;
      }
      case DHCP_OPTION.LEASE_TIME:
      case DHCP_OPTION.RENEWAL_TIME:
      case DHCP_OPTION.REBINDING_TIME: {
        buf[offset++] = 4;
        const num = value as number;
        buf[offset++] = (num >>> 24) & 0xFF;
        buf[offset++] = (num >>> 16) & 0xFF;
        buf[offset++] = (num >>> 8) & 0xFF;
        buf[offset++] = num & 0xFF;
        break;
      }
      case DHCP_OPTION.NETBIOS_NODE_TYPE: {
        buf[offset++] = 1;
        buf[offset++] = value as number;
        break;
      }
      case DHCP_OPTION.DOMAIN_NAME:
      case DHCP_OPTION.MESSAGE:
      case DHCP_OPTION.TFTP_SERVER_NAME:
      case DHCP_OPTION.BOOTFILE_NAME: {
        const str = value as string;
        buf[offset++] = str.length;
        for (let i = 0; i < str.length; i++) {
          buf[offset++] = str.charCodeAt(i);
        }
        break;
      }
      case DHCP_OPTION.PARAMETER_REQUEST_LIST: {
        const list = value as number[];
        buf[offset++] = list.length;
        for (const item of list) {
          buf[offset++] = item;
        }
        break;
      }
      default: {
        // Generic: store as raw bytes if Uint8Array, else skip
        if (value instanceof Uint8Array) {
          buf[offset++] = value.length;
          buf.set(value, offset);
          offset += value.length;
        } else {
          // Unknown option type, skip
          buf[offset++] = 0;
        }
        break;
      }
    }

    return offset;
  }

  private static parseOption(code: number, data: Uint8Array): unknown {
    switch (code) {
      case DHCP_OPTION.MESSAGE_TYPE:
        return data[0];

      case DHCP_OPTION.SUBNET_MASK:
      case DHCP_OPTION.ROUTER:
      case DHCP_OPTION.SERVER_IDENTIFIER:
      case DHCP_OPTION.REQUESTED_IP:
        return DHCPPacket.readIP(data, 0);

      case DHCP_OPTION.DNS:
      case DHCP_OPTION.NETBIOS_NAME_SERVER: {
        const servers: string[] = [];
        for (let i = 0; i < data.length; i += 4) {
          servers.push(DHCPPacket.readIP(data, i));
        }
        return servers;
      }

      case DHCP_OPTION.LEASE_TIME:
      case DHCP_OPTION.RENEWAL_TIME:
      case DHCP_OPTION.REBINDING_TIME:
        return ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;

      case DHCP_OPTION.NETBIOS_NODE_TYPE:
        return data[0];

      case DHCP_OPTION.DOMAIN_NAME:
      case DHCP_OPTION.MESSAGE:
      case DHCP_OPTION.TFTP_SERVER_NAME:
      case DHCP_OPTION.BOOTFILE_NAME: {
        let str = '';
        for (let i = 0; i < data.length; i++) {
          str += String.fromCharCode(data[i]);
        }
        return str;
      }

      case DHCP_OPTION.PARAMETER_REQUEST_LIST:
        return Array.from(data);

      default:
        return data;
    }
  }
}

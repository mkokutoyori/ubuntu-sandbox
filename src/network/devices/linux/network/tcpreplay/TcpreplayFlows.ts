import { warningText } from './TcpreplayDiagnostics';
import { ETHERTYPES, datalinkDescription, linkLayoutOf } from './TcpreplayLink';

export type FlowEntryType = 'new' | 'existing' | 'expired' | 'non-ip' | 'invalid';

const IPV4_HEADER_BYTES = 20;
const IPV6_HEADER_BYTES = 40;
const TCP_HEADER_BYTES = 20;
const UDP_HEADER_BYTES = 8;
const ICMP_HEADER_BYTES = 28;
const PROTOCOL_TCP = 6;
const PROTOCOL_UDP = 17;
const PROTOCOL_ICMP = 1;
const PROTOCOL_ICMPV6 = 58;
const ADDRESS_BYTES = 16;

function byteAt(bytes: Uint8Array, at: number): number {
  return at < bytes.length ? bytes[at] : 0;
}

function addressKey(bytes: Uint8Array, at: number, length: number): string {
  let key = '';
  for (let i = 0; i < ADDRESS_BYTES; i++) key += (i < length ? byteAt(bytes, at + i) : 0).toString(16).padStart(2, '0');
  return key;
}

export class FlowTable {
  private readonly lastSeen = new Map<string, number>();

  decode(bytes: Uint8Array, seconds: number, datalink: number, expiry: number, warn: (text: string) => void): FlowEntryType {
    const layout = linkLayoutOf(bytes, datalink);
    if (layout === null) {
      warn(warningText('flows.c', 'flow_decode', 198, `Unable to process unsupported DLT type: ${datalinkDescription(datalink)} (0x${datalink.toString(16)})`));
      return 'invalid';
    }
    const length = bytes.length;
    const { l2len, protocol: etherType } = layout;
    let ipLength: number;
    let protocol: number;
    let source: string;
    let destination: string;
    if (etherType === ETHERTYPES.ip) {
      if (length < l2len + IPV4_HEADER_BYTES) return 'invalid';
      if (bytes[l2len] >> 4 !== 4) return 'non-ip';
      ipLength = (bytes[l2len] & 0x0f) * 4;
      protocol = bytes[l2len + 9];
      source = addressKey(bytes, l2len + 12, 4);
      destination = addressKey(bytes, l2len + 16, 4);
    } else if (etherType === ETHERTYPES.ip6) {
      if (length < l2len + IPV6_HEADER_BYTES) return 'invalid';
      if (bytes[0] >> 4 !== 6) return 'non-ip';
      ipLength = IPV6_HEADER_BYTES;
      protocol = bytes[l2len + 6];
      if (protocol === 0) {
        ipLength += (byteAt(bytes, l2len + IPV6_HEADER_BYTES + 1) + 1) * 8;
        protocol = byteAt(bytes, l2len + IPV6_HEADER_BYTES);
      }
      source = addressKey(bytes, l2len + 8, ADDRESS_BYTES);
      destination = addressKey(bytes, l2len + 24, ADDRESS_BYTES);
    } else return 'non-ip';

    let sourcePort = 0;
    let destinationPort = 0;
    const transport = l2len + ipLength;
    switch (protocol) {
      case PROTOCOL_UDP:
        if (length < transport + UDP_HEADER_BYTES) return 'invalid';
        sourcePort = (bytes[transport] << 8) | bytes[transport + 1];
        destinationPort = (bytes[transport + 2] << 8) | bytes[transport + 3];
        break;
      case PROTOCOL_TCP:
        if (length < transport + TCP_HEADER_BYTES) return 'invalid';
        sourcePort = (bytes[transport] << 8) | bytes[transport + 1];
        destinationPort = (bytes[transport + 2] << 8) | bytes[transport + 3];
        break;
      case PROTOCOL_ICMP:
      case PROTOCOL_ICMPV6:
        if (length < transport + ICMP_HEADER_BYTES) return 'invalid';
        sourcePort = bytes[transport];
        destinationPort = bytes[transport + 1];
        break;
      default:
        break;
    }
    return this.record(`${source}|${destination}|${sourcePort}|${destinationPort}|${protocol}`, seconds, expiry);
  }

  private record(key: string, seconds: number, expiry: number): FlowEntryType {
    const previous = this.lastSeen.get(key);
    if (previous === undefined) {
      this.lastSeen.set(key, expiry !== 0 ? seconds : 0);
      return 'new';
    }
    const expired = expiry !== 0 && seconds > expiry + previous;
    if (expiry !== 0) this.lastSeen.set(key, seconds);
    return expired ? 'expired' : 'existing';
  }
}

export function uniqueAddressEdit(bytes: Uint8Array, iteration: number, cached: boolean, datalink: number): boolean {
  const layout = linkLayoutOf(bytes, datalink);
  if (layout === null) return false;
  const { l2len, protocol } = layout;
  let sourceAt: number;
  let destinationAt: number;
  if (protocol === ETHERTYPES.ip) {
    if (bytes.length < l2len + IPV4_HEADER_BYTES) return false;
    sourceAt = l2len + 12;
    destinationAt = l2len + 16;
  } else if (protocol === ETHERTYPES.ip6) {
    if (bytes.length < l2len + IPV6_HEADER_BYTES) return false;
    sourceAt = l2len + 8 + 12;
    destinationAt = l2len + 24 + 12;
  } else return false;

  const read = (at: number) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  const write = (at: number, value: number) => {
    bytes[at] = value >>> 24;
    bytes[at + 1] = (value >>> 16) & 0xff;
    bytes[at + 2] = (value >>> 8) & 0xff;
    bytes[at + 3] = value & 0xff;
  };
  const sourceOriginal = read(sourceAt);
  const destinationOriginal = read(destinationAt);
  let source = sourceOriginal;
  let destination = destinationOriginal;
  const wrap = (value: number) => value >>> 0;

  const wide = (value: bigint) => BigInt.asUintN(64, value);
  const destinationAbove = !cached
    ? destination > source
    : wide(BigInt(destination) - BigInt(iteration)) > wide(BigInt((source - 1) >>> 0) - BigInt(iteration));
  if (destinationAbove) {
    if (cached) {
      source = wrap(source - 1);
      destination = wrap(destination + 1);
    } else {
      source = wrap(source - iteration);
      destination = wrap(destination + iteration);
    }
    if (source > sourceOriginal && destination > destinationOriginal) source = wrap(source - 1);
    else if (destination < destinationOriginal && source < sourceOriginal) destination = wrap(destination + 1);
  } else {
    if (cached) {
      source = wrap(source + 1);
      destination = wrap(destination - 1);
    } else {
      source = wrap(source + iteration);
      destination = wrap(destination - iteration);
    }
    if (destination > destinationOriginal && source > sourceOriginal) destination = wrap(destination - 1);
    else if (source < sourceOriginal && destination < destinationOriginal) source = wrap(source + 1);
  }
  write(sourceAt, source);
  write(destinationAt, destination);
  return true;
}

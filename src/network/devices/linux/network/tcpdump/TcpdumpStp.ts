import { fixed } from '@/bash/runtime/Printf';
import { printableByte } from './TcpdumpHex';

const TIMER_UNITS_PER_SECOND = 256;
const CONFIG_BPDU_BYTES = 35;
const RAPID_BPDU_BYTES = 36;
const MSTP_MIN_BYTES = 102;
const VERSION_3_LENGTH_OFFSET = 36;
const CONFIG_NAME_OFFSET = 39;
const CONFIG_NAME_BYTES = 32;
const CONFIG_DIGEST_OFFSET = 73;
const CIST_INTERNAL_COST_OFFSET = 89;
const CIST_BRIDGE_OFFSET = 93;
const CIST_REMAINING_HOPS_OFFSET = 101;
const MSTI_OFFSET = 102;
const MSTI_BYTES = 16;
const MSTI_CONFIG_INFO_BYTES = 64;
const SPB_MIN_BYTES = 87;
const SPB_NAME_OFFSET = 3;
const SPB_REVISION_OFFSET = SPB_NAME_OFFSET + CONFIG_NAME_BYTES;
const SPB_DIGEST_OFFSET = SPB_REVISION_OFFSET + 2;
const SPB_AGREEMENT_OFFSET = SPB_DIGEST_OFFSET + 16;
const SPB_FORMAT_OFFSET = SPB_AGREEMENT_OFFSET + 2;
const SPB_CONVENTION_OFFSET = SPB_FORMAT_OFFSET + 1;
const SPB_EDGE_OFFSET = SPB_CONVENTION_OFFSET + 1;
const SPB_AGREEMENT_DIGEST_OFFSET = SPB_EDGE_OFFSET + 2 + 8;

const PROTOCOLS: Readonly<Record<number, string>> = { 0: '802.1d', 2: '802.1w', 3: '802.1s', 4: '802.1aq' };
const BPDU_TYPES: Readonly<Record<number, string>> = { 0x00: 'Config', 0x02: 'Rapid STP', 0x80: 'Topology Change' };
const PORT_ROLES: Readonly<Record<number, string>> = { 0: 'Unknown', 1: 'Alternate', 2: 'Root', 3: 'Designated' };
const FLAGS: ReadonlyArray<readonly [number, string]> = [
  [0x01, 'Topology change'], [0x02, 'Proposal'], [0x10, 'Learn'], [0x20, 'Forward'], [0x40, 'Agreement'], [0x80, 'Topology change ACK'],
];

const INVALID = ' (invalid)';

class Truncated extends Error {}

class Bytes {
  constructor(private readonly bytes: readonly number[]) {}

  u8(at: number): number {
    if (at >= this.bytes.length) throw new Truncated();
    return this.bytes[at];
  }

  u16(at: number): number {
    return (this.u8(at) << 8) | this.u8(at + 1);
  }

  u32(at: number): number {
    return ((this.u8(at) << 24) | (this.u8(at + 1) << 16) | (this.u8(at + 2) << 8) | this.u8(at + 3)) >>> 0;
  }

  slice(at: number, length: number): number[] {
    this.u8(at + length - 1);
    return this.bytes.slice(at, at + length);
  }
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

function flagNames(flags: number): string {
  const found = FLAGS.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name);
  return found.length === 0 ? 'none' : found.join(', ');
}

function bridgeId(bytes: Bytes, at: number): string {
  const pair = (offset: number): string => hex(bytes.u8(at + offset), 2);
  return `${pair(0)}${pair(1)}.${[2, 3, 4, 5, 6, 7].map(pair).join(':')}`;
}

function seconds(bytes: Bytes, at: number): string {
  return `${fixed(bytes.u16(at) / TIMER_UNITS_PER_SECOND, 2)}s`;
}

function timers(bytes: Bytes): string {
  return `\n\tmessage-age ${seconds(bytes, 27)}, max-age ${seconds(bytes, 29)}, hello-time ${seconds(bytes, 31)}, forwarding-delay ${seconds(bytes, 33)}`;
}

function digest(bytes: Bytes, at: number, words: number): string {
  let text = '';
  for (let word = 0; word < words; word++) text += hex(bytes.u32(at + word * 4), 8);
  return text;
}

function roleOf(flags: number): string {
  return PORT_ROLES[(flags & 0x0c) >> 2];
}

class Sink {
  text = '';

  add(piece: string): void {
    this.text += piece;
  }
}

function printName(bytes: Bytes, at: number, out: Sink): void {
  for (let index = 0; index < CONFIG_NAME_BYTES; index++) {
    const byte = bytes.u8(at + index);
    if (byte === 0) return;
    out.add(printableByte(byte));
  }
}

function configBpdu(bytes: Bytes, length: number, verbose: number, out: Sink): void {
  const flags = bytes.u8(4);
  out.add(`, Flags [${flagNames(flags)}]`);
  out.add(`, bridge-id ${bridgeId(bytes, 17)}.${hex(bytes.u16(25), 4)}, length ${length}`);
  if (verbose === 0) return;
  out.add(timers(bytes));
  out.add(`\n\troot-id ${bridgeId(bytes, 5)}, root-pathcost ${bytes.u32(13)}`);
  if (bytes.u8(2) === 2) out.add(`, port-role ${roleOf(flags)}`);
}

function mstpBpdu(bytes: Bytes, length: number, verbose: number, out: Sink): void {
  const flags = bytes.u8(4);
  out.add(`, CIST Flags [${flagNames(flags)}], length ${length}`);
  if (verbose === 0) return;
  out.add(`\n\tport-role ${roleOf(flags)}, `);
  out.add(`CIST root-id ${bridgeId(bytes, 5)}, CIST ext-pathcost ${bytes.u32(13)}`);
  out.add(`\n\tCIST regional-root-id ${bridgeId(bytes, 17)}, `);
  out.add(`CIST port-id ${hex(bytes.u16(25), 4)},`);
  out.add(timers(bytes));
  out.add(`\n\tv3len ${bytes.u16(VERSION_3_LENGTH_OFFSET)}, `);
  out.add('MCID Name ');
  printName(bytes, CONFIG_NAME_OFFSET, out);
  out.add(`, rev ${bytes.u16(CONFIG_NAME_OFFSET + CONFIG_NAME_BYTES)},\n\t\tdigest ${digest(bytes, CONFIG_DIGEST_OFFSET, 4)}, `);
  out.add(`CIST int-root-pathcost ${bytes.u32(CIST_INTERNAL_COST_OFFSET)},`);
  out.add(`\n\tCIST bridge-id ${bridgeId(bytes, CIST_BRIDGE_OFFSET)}, `);
  out.add(`CIST remaining-hops ${bytes.u8(CIST_REMAINING_HOPS_OFFSET)}`);
  const versionLength = bytes.u16(VERSION_3_LENGTH_OFFSET);
  if (versionLength <= MSTI_CONFIG_INFO_BYTES) return;
  let left = versionLength - MSTI_CONFIG_INFO_BYTES;
  let offset = MSTI_OFFSET;
  while (left >= MSTI_BYTES) {
    const mstiFlags = bytes.u8(offset);
    out.add(`\n\tMSTI ${bytes.u16(offset + 1) & 0x0fff}, Flags [${flagNames(mstiFlags)}], port-role ${roleOf(mstiFlags)}`);
    out.add(`\n\t\tMSTI regional-root-id ${bridgeId(bytes, offset + 1)}, pathcost ${bytes.u32(offset + 9)}`);
    out.add(`\n\t\tMSTI bridge-prio ${bytes.u8(offset + 13) >> 4}, port-prio ${bytes.u8(offset + 14) >> 4}, hops ${bytes.u8(offset + 15)}`);
    left -= MSTI_BYTES;
    offset += MSTI_BYTES;
  }
}

function spbBpdu(bytes: Bytes, offset: number, verbose: number, out: Sink): void {
  if (verbose === 0) return;
  const at = (relative: number): number => offset + relative;
  out.add(`\n\tv4len ${bytes.u16(offset)}, `);
  out.add('AUXMCID Name ');
  printName(bytes, at(SPB_NAME_OFFSET), out);
  out.add(`, Rev ${bytes.u16(at(SPB_REVISION_OFFSET))},\n\t\tdigest ${digest(bytes, at(SPB_DIGEST_OFFSET), 4)}`);
  const agreement = bytes.u8(at(SPB_AGREEMENT_OFFSET));
  const format = bytes.u8(at(SPB_FORMAT_OFFSET));
  const convention = bytes.u8(at(SPB_CONVENTION_OFFSET));
  out.add(`\n\tAgreement num ${agreement >> 6}, Discarded Agreement num ${(agreement >> 4) & 0x3}, Agreement valid-flag ${(agreement >> 3) & 0x1},`
    + `\n\tRestricted role-flag: ${(agreement >> 2) & 0x1}, Format id ${format >> 4} cap ${format & 0xff}, Convention id ${convention >> 4} cap ${convention & 0xff},`
    + `\n\tEdge count ${bytes.u16(at(SPB_EDGE_OFFSET))}, Agreement digest ${digest(bytes, at(SPB_AGREEMENT_DIGEST_OFFSET), 5)}`);
}

function rapidTypeBpdu(bytes: Bytes, version: number, length: number, verbose: number, out: Sink): void {
  if (version === 2) {
    if (length < RAPID_BPDU_BYTES) out.add(INVALID);
    else configBpdu(bytes, length, verbose, out);
    return;
  }
  if (version !== 3 && version !== 4) return;
  if (length < MSTP_MIN_BYTES || bytes.u8(35) !== 0) {
    out.add(INVALID);
    return;
  }
  const mstpLength = bytes.u16(VERSION_3_LENGTH_OFFSET) + 2;
  if (length < RAPID_BPDU_BYTES + mstpLength) {
    out.add(INVALID);
    return;
  }
  mstpBpdu(bytes, length, verbose, out);
  if (version !== 4) return;
  const spbLength = bytes.u16(VERSION_3_LENGTH_OFFSET + mstpLength) + 2;
  if (length < RAPID_BPDU_BYTES + mstpLength + spbLength || spbLength < SPB_MIN_BYTES) {
    out.add(INVALID);
    return;
  }
  spbBpdu(bytes, RAPID_BPDU_BYTES + mstpLength, verbose, out);
}

function print(bytes: Bytes, length: number, verbose: number, out: Sink): void {
  if (length < 4) {
    out.add(INVALID);
    return;
  }
  if (bytes.u16(0) !== 0) {
    out.add(`unknown STP version, length ${length}`);
    return;
  }
  const version = bytes.u8(2);
  const name = PROTOCOLS[version];
  out.add(`STP ${name ?? `Unknown STP protocol (0x${hex(version, 2)})`}`);
  if (name === undefined) return;
  const type = bytes.u8(3);
  out.add(`, ${BPDU_TYPES[type] ?? `Unknown BPDU Type (0x${hex(type, 2)})`}`);
  if (type === 0x00) {
    if (length < CONFIG_BPDU_BYTES) out.add(INVALID);
    else configBpdu(bytes, length, verbose, out);
  } else if (type === 0x02) {
    rapidTypeBpdu(bytes, version, length, verbose, out);
  }
}

export function stpText(payload: readonly number[], length: number, verbose: number): string {
  const out = new Sink();
  try {
    print(new Bytes(payload), length, verbose, out);
  } catch (error) {
    if (!(error instanceof Truncated)) throw error;
    out.add(' [|stp]');
  }
  return out.text;
}

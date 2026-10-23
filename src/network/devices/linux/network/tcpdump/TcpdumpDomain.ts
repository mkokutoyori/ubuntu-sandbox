import { IPv6Address } from '@/network/core/types';

const TYPE_NAMES: Readonly<Record<number, string>> = {
  1: 'A',
  2: 'NS',
  3: 'MD',
  4: 'MF',
  5: 'CNAME',
  6: 'SOA',
  7: 'MB',
  8: 'MG',
  9: 'MR',
  10: 'NULL',
  11: 'WKS',
  12: 'PTR',
  13: 'HINFO',
  14: 'MINFO',
  15: 'MX',
  16: 'TXT',
  17: 'RP',
  18: 'AFSDB',
  19: 'X25',
  20: 'ISDN',
  21: 'RT',
  22: 'NSAP',
  23: 'NSAP_PTR',
  24: 'SIG',
  25: 'KEY',
  26: 'PX',
  27: 'GPOS',
  28: 'AAAA',
  29: 'LOC',
  30: 'NXT',
  31: 'EID',
  32: 'NIMLOC',
  33: 'SRV',
  34: 'ATMA',
  35: 'NAPTR',
  36: 'KX',
  37: 'CERT',
  38: 'A6',
  39: 'DNAME',
  40: 'SINK',
  41: 'OPT',
  42: 'APL',
  43: 'DS',
  44: 'SSHFP',
  45: 'IPSECKEY',
  46: 'RRSIG',
  47: 'NSEC',
  48: 'DNSKEY',
  49: 'DHCID',
  50: 'NSEC3',
  51: 'NSEC3PARAM',
  52: 'TLSA',
  53: 'SMIMEA',
  55: 'HIP',
  56: 'NINFO',
  57: 'RKEY',
  58: 'TALINK',
  59: 'CDS',
  60: 'CDNSKEY',
  61: 'OPENPGPKEY',
  62: 'CSYNC',
  63: 'ZONEMD',
  64: 'SVCB',
  65: 'HTTPS',
  99: 'SPF',
  100: 'UINFO',
  101: 'UID',
  102: 'GID',
  103: 'UNSPEC',
  104: 'NID',
  105: 'L32',
  106: 'L64',
  107: 'LP',
  108: 'EUI48',
  109: 'EUI64',
  249: 'TKEY',
  250: 'TSIG',
  251: 'IXFR',
  252: 'AXFR',
  253: 'MAILB',
  254: 'MAILA',
  255: 'ANY',
  256: 'URI',
  257: 'CAA',
  258: 'AVC',
  259: 'DOA',
  260: 'AMTRELAY',
  32768: 'TA',
  32769: 'DLV'
};

const CLASS_NAMES: Readonly<Record<number, string>> = { 1: 'IN', 3: 'CHAOS', 4: 'HS', 255: 'ANY' };

const EDNS_OPTION_NAMES: Readonly<Record<number, string>> = {
  1: 'LLQ', 2: 'UL', 3: 'NSID', 5: 'DAU', 6: 'DHU', 7: 'N3U', 8: 'ECS', 9: 'EXPIRE', 10: 'COOKIE', 11: 'KEEPALIVE',
  12: 'PADDING', 13: 'CHAIN', 14: 'KEY-TAG', 16: 'CLIENT-TAG', 17: 'SERVER-TAG',
};

const DNSSEC_ALGORITHMS: Readonly<Record<number, string>> = {
  0: 'DELETE', 1: 'RSAMD5', 2: 'DH', 3: 'DS', 5: 'RSASHA1', 6: 'DSA-NSEC3-SHA1', 7: 'RSASHA1-NSEC3-SHA1', 8: 'RSASHA256',
  10: 'RSASHA512', 12: 'ECC-GOST', 13: 'ECDSAP256SHA256', 14: 'ECDSAP384SHA384', 15: 'ED25519', 16: 'ED448',
  252: 'INDIRECT', 253: 'PRIVATEDNS', 254: 'PRIVATEOID',
};

const DS_HASHES: Readonly<Record<number, string>> = { 1: 'SHA-1', 2: 'SHA-256', 3: 'GOST_R_34.11-94', 4: 'SHA-384' };
const NSEC3_HASHES: Readonly<Record<number, string>> = { 1: 'SHA-1' };

const OPERATIONS = ['', ' inv_q', ' stat', ' op3', ' notify', ' update', ' op6', ' op7', ' op8', ' updateA', ' updateD', ' updateDA', ' updateM', ' updateMA', ' zoneInit', ' zoneRef'];

const RESPONSES = [
  '', ' FormErr', ' ServFail', ' NXDomain', ' NotImp', ' Refused', ' YXDomain', ' YXRRSet', ' NXRRSet', ' NotAuth', ' NotZone',
  ' Resp11', ' Resp12', ' Resp13', ' Resp14', ' NoChange', ' BadVers', 'Resp17', ' Resp18', ' Resp19', ' Resp20', 'Resp21',
  ' Resp22', ' BadCookie',
];

const TYPE_MASK = 0xc0;
const TYPE_INDIRECT = 0xc0;
const TYPE_EXTENDED = 0x40;
const TYPE_RESERVED = 0x80;
const BIT_LABEL = 1;
const MAX_COMPRESSED_NAME = 255;
const CLASS_IN = 1;
const CLASS_QU = 0x8000;
const CLASS_CACHE_FLUSH = 0x8000;
const TYPE_OPT = 41;
const INVERSE_QUERY = 1;

class Truncated extends Error {}

function responseCode(rcode: number): string {
  return rcode < RESPONSES.length ? RESPONSES[rcode] : ` Resp${rcode & 0xfff}`;
}

function printableChar(code: number): string {
  let text = '';
  let c = code;
  if (c >= 0x80) {
    c &= 0x7f;
    text += 'M-';
  }
  if (c < 0x20 || c > 0x7e) {
    c ^= 0x40;
    text += '^';
  }
  return text + String.fromCharCode(c);
}

function relativeTime(seconds: number): string {
  const units: ReadonlyArray<readonly [string, number]> = [['y', 31536000], ['w', 604800], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
  if (seconds === 0) return '0s';
  let text = '';
  let remaining = seconds;
  for (const [name, size] of units) {
    if (remaining <= 0) break;
    if (remaining >= size) {
      text += `${Math.floor(remaining / size)}${name}`;
      remaining -= Math.floor(remaining / size) * size;
    }
  }
  return text;
}

export interface DomainContext {
  readonly verbose: number;
  readonly overTcp: boolean;
  readonly multicast: boolean;
}

class DomainPrinter {
  out = '';

  constructor(private readonly bytes: readonly number[], private readonly context: DomainContext) {}

  private get end(): number { return this.bytes.length; }

  private byte(at: number): number { return this.bytes[at]; }

  private u16(at: number): number { return (this.bytes[at] << 8) | this.bytes[at + 1]; }

  private u32(at: number): number {
    return ((this.bytes[at] << 24) | (this.bytes[at + 1] << 16) | (this.bytes[at + 2] << 8) | this.bytes[at + 3]) >>> 0;
  }

  private has(at: number, count: number): boolean { return at >= 0 && at + count <= this.end; }

  private skipName(start: number): number | null {
    let at = start;
    if (!this.has(at, 1)) return null;
    let i = this.byte(at++);
    while (i) {
      switch (i & TYPE_MASK) {
        case TYPE_INDIRECT: return at + 1;
        case TYPE_EXTENDED: {
          if ((i & ~TYPE_MASK) !== BIT_LABEL) return null;
          if (!this.has(at, 1)) return null;
          let bits = this.byte(at++);
          if (bits === 0) bits = 256;
          at += Math.floor((bits + 7) / 8);
          break;
        }
        case TYPE_RESERVED: return null;
        default: at += i;
      }
      if (!this.has(at, 1)) return null;
      i = this.byte(at++);
    }
    return at;
  }

  private labelLength(at: number): number {
    if (!this.has(at, 1)) return -1;
    const i = this.byte(at);
    switch (i & TYPE_MASK) {
      case TYPE_EXTENDED: {
        const element = i & ~TYPE_MASK;
        if (element !== BIT_LABEL) {
          this.out += `<ELT ${element}>`;
          return -1;
        }
        if (!this.has(at + 1, 1)) return -1;
        let bits = this.byte(at + 1);
        if (bits === 0) bits = 256;
        return Math.floor((bits + 7) / 8) + 1;
      }
      case TYPE_INDIRECT: case 0: return i;
      default:
        this.out += '<BAD LABEL TYPE>';
        return -1;
    }
  }

  private printChars(from: number, count: number): boolean {
    let remaining = count;
    let at = from;
    while (remaining > 0 && at < this.end) {
      remaining--;
      this.out += printableChar(this.byte(at++));
    }
    return remaining !== 0;
  }

  private bitLabel(at: number): number | null {
    if (!this.has(at, 1)) return null;
    let bits = this.byte(at);
    if (bits === 0) bits = 256;
    const hexDigits = Math.floor((bits + 3) / 4);
    const limit = at + 1 + hexDigits;
    this.out += '\\[x';
    let cursor = at + 1;
    let remaining = bits;
    for (; cursor < limit && remaining > 7; remaining -= 8, cursor++) this.out += this.byte(cursor).toString(16).padStart(2, '0');
    if (remaining > 4) {
      const value = this.byte(cursor++);
      this.out += (value & (0xff << (8 - remaining)) & 0xff).toString(16).padStart(2, '0');
    } else if (remaining > 0) {
      const value = this.byte(cursor++);
      this.out += ((((value >> 4) & 0x0f) & (0x0f << (4 - remaining))) & 0x0f).toString(16);
    }
    this.out += `/${bits}]`;
    return limit;
  }

  fqdn(start: number, base: number): number | null {
    let at = start;
    let l = this.labelLength(at);
    if (l === -1) return null;
    if (!this.has(at, 1)) return null;
    let maxOffset = at - base;
    let i = this.byte(at);
    at++;
    let compress = false;
    let resume = 0;
    if ((i & TYPE_MASK) !== TYPE_INDIRECT) {
      compress = false;
      resume = at + l;
    }
    let nameChars = 0;
    if (i !== 0) {
      while (i && at < this.end) {
        switch (i & TYPE_MASK) {
          case TYPE_INDIRECT: {
            if (!compress) {
              resume = at + 1;
              compress = true;
            }
            if (!this.has(at, 1)) return null;
            const offset = ((i << 8) | this.byte(at)) & 0x3fff;
            if (offset >= maxOffset) {
              this.out += '<BAD PTR>';
              return null;
            }
            maxOffset = offset;
            at = base + offset;
            if (!this.has(at, 1)) return null;
            i = this.byte(at);
            l = this.labelLength(at);
            if (l === -1) return null;
            at++;
            continue;
          }
          case TYPE_EXTENDED: {
            const element = i & ~TYPE_MASK;
            if (element !== BIT_LABEL) {
              this.out += `<ELT ${element}>`;
              return null;
            }
            if (this.bitLabel(at) === null) return null;
            break;
          }
          case TYPE_RESERVED:
            this.out += '<BAD LABEL TYPE>';
            return null;
          default:
            if (nameChars + l <= MAX_COMPRESSED_NAME) {
              if (this.printChars(at, l)) return null;
            } else if (nameChars < MAX_COMPRESSED_NAME) {
              if (this.printChars(at, MAX_COMPRESSED_NAME - nameChars)) return null;
            }
            nameChars += l;
        }
        at += l;
        if (nameChars <= MAX_COMPRESSED_NAME) this.out += '.';
        nameChars++;
        if (!this.has(at, 1)) return null;
        i = this.byte(at);
        l = this.labelLength(at);
        if (l === -1) return null;
        at++;
        if (!compress) resume += l + 1;
      }
      if (nameChars > MAX_COMPRESSED_NAME) this.out += '<DOMAIN NAME TOO LONG>';
    } else {
      this.out += '.';
    }
    return resume;
  }

  private characterString(at: number): number | null {
    if (!this.has(at, 1)) return null;
    const count = this.byte(at);
    if (this.printChars(at + 1, count)) return null;
    return at + 1 + count;
  }

  private ipv6(at: number): string {
    const hextets: number[] = [];
    for (let i = 0; i < 8; i++) hextets.push(this.u16(at + i * 2));
    return new IPv6Address(hextets).toString();
  }

  private ecs(at: number, length: number): void {
    if (length < 4) { this.out += ' (invalid)'; return; }
    const family = this.u16(at);
    const sourceLength = this.byte(at + 2);
    const scopeLength = this.byte(at + 3);
    const addressBits = family === 1 ? 32 : family === 2 ? 128 : 0;
    if (addressBits === 0 || length - 4 > addressBits / 8 || sourceLength > addressBits || scopeLength > addressBits
      || Math.floor((sourceLength + 7) / 8) !== length - 4) {
      this.out += ' (invalid)';
      return;
    }
    const padded = Array.from({ length: addressBits / 8 }, (_, i) => (i < length - 4 ? this.byte(at + 4 + i) : 0));
    this.out += family === 1
      ? `${padded.join('.')}/${sourceLength}/${scopeLength}`
      : `${new IPv6Address(Array.from({ length: 8 }, (_, i) => (padded[i * 2] << 8) | padded[i * 2 + 1])).toString()}/${sourceLength}/${scopeLength}`;
  }

  private ednsOption(start: number): number | null {
    let at = start;
    if (!this.has(at, 2)) return null;
    const option = this.u16(at);
    at += 2;
    this.out += EDNS_OPTION_NAMES[option] ?? `Opt${option}`;
    if (!this.has(at, 2)) return null;
    const length = this.u16(at);
    at += 2;
    if (!this.has(at, length)) return null;
    if (length > 0) {
      this.out += ' ';
      switch (option) {
        case 8: this.ecs(at, length); break;
        case 10:
          if (length < 8 || (length > 8 && length < 16) || length > 40) this.out += ' (invalid)';
          else for (let i = 0; i < length; i++) this.out += (i === 8 ? ' ' : '') + this.byte(at + i).toString(16).padStart(2, '0');
          break;
        case 11:
          if (length !== 2) this.out += ' (invalid)';
          else this.out += `${(this.u16(at) / 10).toFixed(1)} sec`;
          break;
        case 9:
          if (length !== 4) this.out += ' (invalid)';
          else this.out += `${this.u32(at)} sec`;
          break;
        case 12: this.out += `(${length})`; break;
        case 14:
          if (length % 2 !== 0) this.out += ' (invalid)';
          else for (let i = 0; i < length; i += 2) this.out += (i > 0 ? ' ' : '') + this.u16(at + i);
          break;
        case 5: case 6: case 7: {
          const table = option === 5 ? DNSSEC_ALGORITHMS : option === 6 ? DS_HASHES : NSEC3_HASHES;
          for (let i = 0; i < length; i++) this.out += (i > 0 ? ' ' : '') + (table[this.byte(at + i)] ?? `Alg_${this.byte(at + i)}`);
          break;
        }
        case 13: this.fqdn(at, at + length); break;
        default:
          for (let i = 0; i < length; i++) this.out += this.byte(at + i).toString(16).padStart(2, '0');
      }
    }
    return at + length;
  }

  private question(start: number, base: number): number | null {
    const nameStart = start;
    let at = this.skipName(start);
    if (at === null || !this.has(at, 4)) return null;
    this.out += ` ${TYPE_NAMES[this.u16(at)] ?? `Type${this.u16(at)}`}`;
    at += 2;
    const raw = this.u16(at);
    at += 2;
    const classCode = this.context.multicast ? raw & ~CLASS_QU : raw;
    if (classCode !== CLASS_IN) this.out += ` ${CLASS_NAMES[classCode] ?? `(Class ${classCode})`}`;
    if (this.context.multicast) this.out += (raw & CLASS_QU) !== 0 ? ' (QU)' : ' (QM)';
    this.out += '? ';
    const after = this.fqdn(nameStart, base);
    return after === null ? null : after + 4;
  }

  private record(start: number, base: number): number | null {
    let at: number | null = start;
    if (this.context.verbose > 0) {
      this.out += ' ';
      at = this.fqdn(at, base);
      if (at === null) return null;
    } else {
      at = this.skipName(at);
    }
    if (at === null || !this.has(at, 10)) return this.end;
    const type = this.u16(at);
    at += 2;
    const raw = this.u16(at);
    at += 2;
    const classCode = this.context.multicast ? raw & ~CLASS_CACHE_FLUSH : raw;
    if (classCode !== CLASS_IN && type !== TYPE_OPT) this.out += ` ${CLASS_NAMES[classCode] ?? `(Class ${classCode})`}`;
    if (this.context.multicast && (raw & CLASS_CACHE_FLUSH) !== 0) this.out += ' (Cache flush)';
    let optionFlags = 0;
    if (type === TYPE_OPT) {
      at += 2;
      optionFlags = this.u16(at);
      at += 2;
    } else if (this.context.verbose > 2) {
      this.out += ` [${relativeTime(this.u32(at))}]`;
      at += 4;
    } else {
      at += 4;
    }
    const length = this.u16(at);
    at += 2;
    const recordEnd = at + length;
    this.out += ` ${TYPE_NAMES[type] ?? `Type${type}`}`;
    if (recordEnd > this.end) return null;
    switch (type) {
      case 1:
        if (!this.has(at, 4)) return null;
        this.out += ` ${this.byte(at)}.${this.byte(at + 1)}.${this.byte(at + 2)}.${this.byte(at + 3)}`;
        break;
      case 2: case 5: case 12: case 39:
        this.out += ' ';
        if (this.fqdn(at, base) === null) return null;
        break;
      case 6: {
        if (this.context.verbose === 0) break;
        this.out += ' ';
        let cursor = this.fqdn(at, base);
        if (cursor === null) return null;
        this.out += ' ';
        cursor = this.fqdn(cursor, base);
        if (cursor === null) return null;
        if (!this.has(cursor, 20)) return null;
        for (let i = 0; i < 5; i++) this.out += ` ${this.u32(cursor + i * 4)}`;
        break;
      }
      case 15:
        this.out += ' ';
        if (!this.has(at, 2)) return null;
        if (this.fqdn(at + 2, base) === null) return null;
        this.out += ` ${this.u16(at)}`;
        break;
      case 16: {
        let cursor = at;
        while (cursor < recordEnd) {
          this.out += ' "';
          const next = this.characterString(cursor);
          if (next === null) return null;
          cursor = next;
          this.out += '"';
        }
        break;
      }
      case 33:
        this.out += ' ';
        if (!this.has(at, 6)) return null;
        if (this.fqdn(at + 6, base) === null) return null;
        this.out += `:${this.u16(at + 4)} ${this.u16(at)} ${this.u16(at + 2)}`;
        break;
      case 28:
        if (!this.has(at, 16)) return null;
        this.out += ` ${this.ipv6(at)}`;
        break;
      case 38: {
        if (!this.has(at, 1)) return null;
        const prefixBits = this.byte(at);
        const prefixBytes = (prefixBits & ~7) / 8;
        if (prefixBits > 128) {
          this.out += ` ${prefixBits}(bad plen)`;
          break;
        }
        if (prefixBits < 128) {
          const hextets = Array.from({ length: 16 }, (_, i) => (i >= prefixBytes ? this.byte(at + 1 + i - prefixBytes) : 0));
          this.out += ` ${prefixBits} ${new IPv6Address(Array.from({ length: 8 }, (_, i) => (hextets[i * 2] << 8) | hextets[i * 2 + 1])).toString()}`;
        }
        if (prefixBits > 0) {
          this.out += ' ';
          if (this.fqdn(at + 1 + 16 - prefixBytes, base) === null) return null;
        }
        break;
      }
      case 256:
        if (!this.has(at, length)) return null;
        this.out += ` ${this.u16(at)} ${this.u16(at + 2)} `;
        if (this.printChars(at + 4, length - 4)) return null;
        break;
      case TYPE_OPT: {
        this.out += ` UDPsize=${classCode}`;
        if ((optionFlags & 0x8000) !== 0) this.out += ' DO';
        let cursor = at;
        if (cursor < recordEnd) {
          this.out += ' [';
          while (cursor < recordEnd) {
            const next = this.ednsOption(cursor);
            if (next === null) return null;
            cursor = next;
            if (cursor < recordEnd) this.out += ',';
          }
          this.out += ']';
        }
        break;
      }
      case 250: {
        if (at + length > this.end) return null;
        if (this.context.verbose === 0) break;
        this.out += ' ';
        let cursor = this.fqdn(at, base);
        if (cursor === null) return null;
        cursor += 6;
        if (!this.has(cursor, 2)) return null;
        this.out += ` fudge=${this.u16(cursor)}`;
        cursor += 2;
        if (!this.has(cursor, 2)) return null;
        this.out += ` maclen=${this.u16(cursor)}`;
        cursor += 2 + this.u16(cursor);
        if (!this.has(cursor, 2)) return null;
        this.out += ` origid=${this.u16(cursor)}`;
        cursor += 2;
        if (!this.has(cursor, 2)) return null;
        this.out += ` error=${this.u16(cursor)}`;
        cursor += 2;
        if (!this.has(cursor, 2)) return null;
        this.out += ` otherlen=${this.u16(cursor)}`;
        break;
      }
    }
    return recordEnd;
  }

  private records(start: number, base: number, count: number, label: string | null): { at: number; remaining: number } {
    let at = start;
    let remaining = count;
    if (label !== null) {
      if (!(at < this.end && remaining > 0)) return { at, remaining };
      this.out += label;
    }
    const first = this.record(at, base);
    if (first === null) throw new Truncated();
    at = first;
    remaining--;
    while (at < this.end && remaining > 0) {
      this.out += ',';
      const next = this.record(at, base);
      if (next === null) throw new Truncated();
      at = next;
      remaining--;
    }
    return { at, remaining };
  }

  print(start: number, length: number): void {
    let base = start;
    let size = length;
    if (this.context.overTcp) {
      if (size < 2) {
        this.out += ` [DNS over TCP: length ${size} < 2] (invalid)`;
        return;
      }
      size -= 2;
      if (this.u16(base) !== size) {
        this.out += ` [prefix length(${this.u16(base)}) != length(${size})] (invalid)`;
        return;
      }
      base += 2;
      this.out += ' ';
    }
    if (size < 12) {
      this.out += ` [|domain] [length ${size} < 12] (invalid)`;
      return;
    }
    if (!this.has(base, 12)) {
      this.out += ' [|domain]';
      return;
    }
    try {
      this.message(base, size);
    } catch (error) {
      if (!(error instanceof Truncated)) throw error;
      this.out += ' [|domain]';
    }
  }

  private message(base: number, size: number): void {
    const flags = this.u16(base + 2);
    let qdcount = this.u16(base + 4);
    let ancount = this.u16(base + 6);
    let nscount = this.u16(base + 8);
    let arcount = this.u16(base + 10);
    const opcode = (flags >> 11) & 0xf;
    const rcode = this.extendedResponseCode(base, flags, qdcount, ancount, nscount, arcount);
    const isResponse = (flags & 0x8000) !== 0;
    let cp = base + 12;
    if (isResponse) {
      this.out += `${this.u16(base)}${OPERATIONS[opcode]}${responseCode(rcode)}${(flags & 0x0400) !== 0 ? '*' : ''}${(flags & 0x0080) !== 0 ? '' : '-'}${(flags & 0x0200) !== 0 ? '|' : ''}${(flags & 0x0020) !== 0 ? '$' : ''}`;
      if (qdcount !== 1) this.out += ` [${qdcount}q]`;
      for (let i = 0; i < qdcount; i++) {
        if (i !== 0) this.out += ',';
        if (this.context.verbose > 1) {
          this.out += ' q:';
          const next = this.question(cp, base);
          if (next === null) throw new Truncated();
          cp = next;
        } else {
          const skipped = this.skipName(cp);
          if (skipped === null) throw new Truncated();
          cp = skipped + 4;
        }
      }
      this.out += ` ${ancount}/${nscount}/${arcount}`;
      if (ancount > 0) {
        const done = this.records(cp, base, ancount, null);
        cp = done.at;
        ancount = done.remaining;
      }
      if (ancount > 0) throw new Truncated();
      if (this.context.verbose > 1) {
        if (cp < this.end && nscount > 0) {
          const done = this.records(cp, base, nscount, ' ns:');
          cp = done.at;
          nscount = done.remaining;
        }
        if (nscount > 0) throw new Truncated();
        if (cp < this.end && arcount > 0) {
          const done = this.records(cp, base, arcount, ' ar:');
          cp = done.at;
          arcount = done.remaining;
        }
        if (arcount > 0) throw new Truncated();
      }
    } else {
      this.out += `${this.u16(base)}${OPERATIONS[opcode]}${(flags & 0x0100) !== 0 ? '+' : ''}${(flags & 0x0010) !== 0 ? '%' : ''}`;
      if ((this.u16(base + 2) & 0x6cf) !== 0) this.out += ` [b2&3=0x${this.u16(base + 2).toString(16)}]`;
      if (opcode === INVERSE_QUERY) {
        if (qdcount > 0) this.out += ` [${qdcount}q]`;
        if (ancount !== 1) this.out += ` [${ancount}a]`;
      } else {
        if (ancount > 0) this.out += ` [${ancount}a]`;
        if (qdcount !== 1) this.out += ` [${qdcount}q]`;
      }
      if (nscount > 0) this.out += ` [${nscount}n]`;
      if (arcount > 0) this.out += ` [${arcount}au]`;
      if (qdcount > 0) {
        let next = this.question(cp, base);
        if (next === null) throw new Truncated();
        cp = next;
        qdcount--;
        while (cp < this.end && qdcount > 0) {
          next = this.question(cp, base);
          if (next === null) throw new Truncated();
          cp = next;
          qdcount--;
        }
      }
      if (qdcount > 0) throw new Truncated();
      if (this.context.verbose > 1) {
        if (ancount > 0) {
          const done = this.records(cp, base, ancount, null);
          cp = done.at;
          ancount = done.remaining;
        }
        if (ancount > 0) throw new Truncated();
        if (cp < this.end && nscount > 0) {
          const done = this.records(cp, base, nscount, ' ns:');
          cp = done.at;
          nscount = done.remaining;
        }
        if (nscount > 0) throw new Truncated();
        if (cp < this.end && arcount > 0) {
          const done = this.records(cp, base, arcount, ' ar:');
          cp = done.at;
          arcount = done.remaining;
        }
        if (arcount > 0) throw new Truncated();
      }
    }
    this.out += ` (${size})`;
  }

  private extendedResponseCode(base: number, flags: number, qdcount: number, ancount: number, nscount: number, arcount: number): number {
    let rcode = flags & 0xf;
    let cp: number | null = base + 12;
    for (let i = 0; i < qdcount; i++) {
      cp = this.skipName(cp as number);
      if (cp === null) return rcode;
      cp += 4;
      if (cp >= this.end) return rcode;
    }
    for (let i = 0; i < ancount + nscount; i++) {
      cp = this.skipName(cp as number);
      if (cp === null) return rcode;
      cp += 8;
      if (cp + 2 > this.end) return rcode;
      cp += 2 + this.u16(cp);
      if (cp >= this.end) return rcode;
    }
    for (let i = 0; i < arcount; i++) {
      cp = this.skipName(cp as number);
      if (cp === null) return rcode;
      if (cp + 2 > this.end) return rcode;
      const type = this.u16(cp);
      cp += 4;
      if (cp + 1 > this.end) return rcode;
      if (type === TYPE_OPT) return rcode | (this.byte(cp) << 4);
      cp += 4;
      if (cp + 2 > this.end) return rcode;
      cp += 2 + this.u16(cp);
      if (cp >= this.end) return rcode;
    }
    return rcode;
  }
}

export function domainText(message: readonly number[], length: number, context: DomainContext): string {
  const printer = new DomainPrinter(message, context);
  printer.print(0, length);
  return printer.out;
}

export const DnsOpcode = {
  QUERY: 0,
  IQUERY: 1,
  STATUS: 2,
  NOTIFY: 4,
  UPDATE: 5,
} as const;

export const DnsRcode = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  NOTIMP: 4,
  REFUSED: 5,
} as const;

export interface DnsHeaderFlags {
  readonly qr: boolean;
  readonly opcode: number;
  readonly aa: boolean;
  readonly tc: boolean;
  readonly rd: boolean;
  readonly ra: boolean;
  readonly ad: boolean;
  readonly cd: boolean;
  readonly rcode: number;
}

const QR_BIT = 15;
const OPCODE_SHIFT = 11;
const AA_BIT = 10;
const TC_BIT = 9;
const RD_BIT = 8;
const RA_BIT = 7;
const AD_BIT = 5;
const CD_BIT = 4;

const FOUR_BIT_MAX = 0x0f;

export class DnsHeaderFlagsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DnsHeaderFlagsError';
  }
}

export function encodeDnsHeaderFlags(flags: DnsHeaderFlags): number {
  if (flags.opcode < 0 || flags.opcode > FOUR_BIT_MAX) {
    throw new DnsHeaderFlagsError(
      `opcode must fit in 4 bits (0-15), got ${flags.opcode}`);
  }
  if (flags.rcode < 0 || flags.rcode > FOUR_BIT_MAX) {
    throw new DnsHeaderFlagsError(
      `rcode must fit in 4 bits (0-15) — use EDNS extended RCODE for larger values, got ${flags.rcode}`);
  }

  let word = 0;
  if (flags.qr) word |= 1 << QR_BIT;
  word |= (flags.opcode & FOUR_BIT_MAX) << OPCODE_SHIFT;
  if (flags.aa) word |= 1 << AA_BIT;
  if (flags.tc) word |= 1 << TC_BIT;
  if (flags.rd) word |= 1 << RD_BIT;
  if (flags.ra) word |= 1 << RA_BIT;
  if (flags.ad) word |= 1 << AD_BIT;
  if (flags.cd) word |= 1 << CD_BIT;
  word |= flags.rcode & FOUR_BIT_MAX;
  return word;
}

export function decodeDnsHeaderFlags(word: number): DnsHeaderFlags {
  return {
    qr: !!((word >> QR_BIT) & 1),
    opcode: (word >> OPCODE_SHIFT) & FOUR_BIT_MAX,
    aa: !!((word >> AA_BIT) & 1),
    tc: !!((word >> TC_BIT) & 1),
    rd: !!((word >> RD_BIT) & 1),
    ra: !!((word >> RA_BIT) & 1),
    ad: !!((word >> AD_BIT) & 1),
    cd: !!((word >> CD_BIT) & 1),
    rcode: word & FOUR_BIT_MAX,
  };
}

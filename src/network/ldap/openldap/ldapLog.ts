export const LdapDebug = {
  TRACE: 0x0001,
  PACKETS: 0x0002,
  ARGS: 0x0004,
  CONNS: 0x0008,
  BER: 0x0010,
  FILTER: 0x0020,
  CONFIG: 0x0040,
  ACL: 0x0080,
  STATS: 0x0100,
  STATS2: 0x0200,
  SHELL: 0x0400,
  PARSE: 0x0800,
  CACHE: 0x1000,
  INDEX: 0x2000,
  SYNC: 0x4000,
  NONE: 0x8000,
  ANY: -1,
} as const;

export class LdapLog {
  level = 0;

  constructor(private readonly writeStderr: (text: string) => void) {}

  enabled(bit: number): boolean {
    return (this.level & bit) !== 0;
  }

  debug(bit: number, text: string): void {
    if ((this.level & bit) !== 0) this.writeStderr(text);
  }

  raw(text: string): void {
    this.writeStderr(text);
  }
}

const HEX_DIGITS = '0123456789abcdef';
const BP_OFFSET = 9;
const BP_GRAPH = 60;
const BP_LINE = 80;

function isPrintable(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

export function berBprint(data: Uint8Array): string {
  if (data.length === 0) return '\n';
  let out = '';
  let line: string[] = [];
  for (let i = 0; i < data.length; i++) {
    const n = i % 16;
    if (n === 0) {
      if (i > 0) out += line.join('');
      line = new Array<string>(BP_LINE - 2).fill(' ');
      line.push('\n');
      const offset = i % 0xffff;
      line[2] = HEX_DIGITS[(offset >> 12) & 0x0f];
      line[3] = HEX_DIGITS[(offset >> 8) & 0x0f];
      line[4] = HEX_DIGITS[(offset >> 4) & 0x0f];
      line[5] = HEX_DIGITS[offset & 0x0f];
      line[6] = ':';
    }
    const hexAt = BP_OFFSET + n * 3 + (n >= 8 ? 1 : 0);
    line[hexAt] = HEX_DIGITS[(data[i] >> 4) & 0x0f];
    line[hexAt + 1] = HEX_DIGITS[data[i] & 0x0f];
    line[BP_GRAPH + n] = isPrintable(data[i]) ? String.fromCharCode(data[i]) : '.';
  }
  out += line.join('');
  return out;
}

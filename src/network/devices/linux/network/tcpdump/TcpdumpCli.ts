export type TimestampMode = 'time' | 'none' | 'epoch' | 'delta' | 'datetime';
export type HexMode = 'none' | 'hex' | 'hexascii';

export interface TcpdumpOptions {
  iface: string;
  count: number | null;
  snaplen: number;
  numeric: boolean;
  tsMode: TimestampMode;
  linkLevel: boolean;
  verbose: number;
  quiet: boolean;
  hex: HexMode;
  hexLink: boolean;
  ascii: boolean;
  writeFile: string | null;
  readFile: string | null;
  linkType: string;
  fileSizeLimit: number | null;
  filterTokens: string[];
}

export type Invocation =
  | { kind: 'error'; message: string }
  | { kind: 'help'; text: string }
  | { kind: 'version'; text: string }
  | { kind: 'list-interfaces' }
  | { kind: 'list-link-types'; iface: string }
  | { kind: 'capture'; options: TcpdumpOptions };

const VERSION_TEXT = [
  'tcpdump version 4.99.1',
  'libpcap version 1.10.1 (with TPACKET_V3)',
  'OpenSSL 3.0.2 15 Mar 2022',
].join('\n');

const USAGE_TEXT = [
  'Usage: tcpdump [-AbdDefhHIJKlLnNOpqStuUvxX#] [ -B size ] [ -c count ] [--count]',
  '\t\t[ -C file_size ] [ -E algo:secret ] [ -F file ] [ -G seconds ]',
  '\t\t[ -i interface ] [ -j tstamptype ] [ -M secret ] [ --number ]',
  '\t\t[ -Q in|out|inout ] [ -r file ] [ -s snaplen ] [ -T type ]',
  '\t\t[ --version ] [ -V file ] [ -w file ] [ -W filecount ] [ -y datalinktype ]',
  '\t\t[ -z postrotate-command ] [ -Z user ] [ expression ]',
].join('\n');

const KNOWN_LINKTYPES = new Set([
  'EN10MB', 'EN3MB', 'SLIP', 'PPP', 'FDDI', 'RAW', 'NULL', 'LOOP',
  'LINUX_SLL', 'IEEE802_11', 'PPP_SERIAL', 'C_HDLC',
]);

function defaults(): TcpdumpOptions {
  return {
    iface: 'eth0',
    count: null,
    snaplen: 262144,
    numeric: false,
    tsMode: 'time',
    linkLevel: false,
    verbose: 0,
    quiet: false,
    hex: 'none',
    hexLink: false,
    ascii: false,
    writeFile: null,
    readFile: null,
    linkType: 'EN10MB',
    fileSizeLimit: null,
    filterTokens: [],
  };
}

const ARG_FLAGS = new Set(['i', 'c', 's', 'y', 'w', 'r', 'C', 'F', 'B', 'G', 'W', 'E', 'M', 'Q', 'T', 'j']);
const BOOL_FLAGS = new Set(['e', 'q', 'A', 'S', 'l', 'p', 'N', 'O', 'U', 'b', 'I', 'K', 'H', 'L', 'u', '#']);

export function parseInvocation(tokens: string[]): Invocation {
  const opt = defaults();
  let tCount = 0;
  let vCount = 0;
  let xUpper = 0;
  let xLower = 0;
  const filter: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === '--help') return { kind: 'help', text: USAGE_TEXT };
    if (token === '--version') return { kind: 'version', text: VERSION_TEXT };
    if (token === '--list-interfaces') return { kind: 'list-interfaces' };
    if (token === '--list-link-types') return { kind: 'list-link-types', iface: opt.iface };
    if (token === '--number') { opt.numeric = true; continue; }
    if (token === '--linktype') {
      const value = tokens[++i];
      if (value === undefined) return { kind: 'error', message: "tcpdump: error: option requires an argument -- 'y'" };
      if (!KNOWN_LINKTYPES.has(value.toUpperCase())) return { kind: 'error', message: `tcpdump: error: invalid data link type ${value}` };
      opt.linkType = value.toUpperCase();
      continue;
    }

    if (token.length > 1 && token.startsWith('-') && !token.startsWith('--')) {
      const cluster = token.slice(1);
      let consumed = false;
      for (let c = 0; c < cluster.length; c++) {
        const ch = cluster[c];
        if (ch === 't') { tCount++; continue; }
        if (ch === 'v') { vCount++; continue; }
        if (ch === 'X') { xUpper++; continue; }
        if (ch === 'x') { xLower++; continue; }
        if (ch === 'n') { opt.numeric = true; continue; }
        if (ch === 'D') return { kind: 'list-interfaces' };
        if (ch === 'h') return { kind: 'version', text: VERSION_TEXT };
        if (BOOL_FLAGS.has(ch)) {
          if (ch === 'e') opt.linkLevel = true;
          else if (ch === 'q') opt.quiet = true;
          else if (ch === 'A') opt.ascii = true;
          continue;
        }
        if (ARG_FLAGS.has(ch)) {
          const glued = cluster.slice(c + 1);
          const value = glued !== '' ? glued : tokens[++i];
          if (value === undefined) {
            return { kind: 'error', message: `tcpdump: error: option requires an argument -- '${ch}'` };
          }
          const applied = applyArgFlag(opt, ch, value);
          if (applied) return applied;
          consumed = true;
          break;
        }
        return { kind: 'error', message: `tcpdump: error: invalid option -- '${ch}'` };
      }
      if (consumed) continue;
      continue;
    }

    if (token !== '') filter.push(token);
  }

  if (tCount === 1) opt.tsMode = 'none';
  else if (tCount === 2) opt.tsMode = 'epoch';
  else if (tCount === 3) opt.tsMode = 'delta';
  else if (tCount >= 4) opt.tsMode = 'datetime';
  opt.verbose = vCount;
  if (xUpper > 0) { opt.hex = 'hexascii'; opt.hexLink = xUpper >= 2; }
  else if (xLower > 0) { opt.hex = 'hex'; opt.hexLink = xLower >= 2; }

  opt.filterTokens = expandFilterTokens(filter);
  return { kind: 'capture', options: opt };
}

function applyArgFlag(opt: TcpdumpOptions, ch: string, value: string): Invocation | null {
  switch (ch) {
    case 'i':
      opt.iface = value;
      return null;
    case 'c': {
      if (!/^\d+$/.test(value)) {
        return { kind: 'error', message: `tcpdump: error: invalid packet count ${value}` };
      }
      opt.count = parseInt(value, 10);
      return null;
    }
    case 's': {
      if (!/^\d+$/.test(value)) {
        return { kind: 'error', message: `tcpdump: error: invalid snaplen ${value}` };
      }
      opt.snaplen = parseInt(value, 10);
      return null;
    }
    case 'y': {
      if (!KNOWN_LINKTYPES.has(value.toUpperCase())) {
        return { kind: 'error', message: `tcpdump: error: invalid data link type ${value}` };
      }
      opt.linkType = value.toUpperCase();
      return null;
    }
    case 'w':
      opt.writeFile = value;
      return null;
    case 'r':
      opt.readFile = value;
      return null;
    case 'C': {
      if (!/^\d+$/.test(value)) {
        return { kind: 'error', message: `tcpdump: error: invalid file size ${value}` };
      }
      opt.fileSizeLimit = parseInt(value, 10);
      return null;
    }
    default:
      return null;
  }
}

function expandFilterTokens(filter: string[]): string[] {
  const out: string[] = [];
  for (const raw of filter) {
    const stripped = raw.replace(/\\([()])/g, '$1');
    for (const piece of stripped.split(/\s+/)) {
      if (piece === '') continue;
      const parens = piece.match(/^(\(*)(.*?)(\)*)$/);
      if (parens && (parens[1] || parens[3]) && parens[2] !== '') {
        for (const ch of parens[1]) out.push(ch);
        out.push(parens[2]);
        for (const ch of parens[3]) out.push(ch);
      } else {
        out.push(piece);
      }
    }
  }
  return out;
}

export function listInterfacesText(names: string[]): string {
  return names.map((name, idx) => `${idx + 1}.${name} [Up, Running]`).join('\n');
}

export function listLinkTypesText(iface: string): string {
  return [
    `Data link types for ${iface} (use option -y to set):`,
    '  EN10MB (Ethernet)',
    '  DOCSIS (DOCSIS)',
  ].join('\n');
}

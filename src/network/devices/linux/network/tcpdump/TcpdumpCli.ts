export type TimestampMode = 'time' | 'none' | 'epoch' | 'delta' | 'datetime' | 'since-first';
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
  requestedLinkType: string | null;
  fileSizeLimit: number | null;
  filterTokens: string[];
  direction: 'in' | 'out' | 'inout';
  absoluteSeq: boolean;
  skipChecksumCheck: boolean;
  packetNumbers: boolean;
  monitorMode: boolean;
  nanoPrecision: boolean;
  countOnly: boolean;
  printWhileWriting: boolean;
  foreignNumeric: boolean;
  stripDomain: boolean;
  noPromiscuous: boolean;
  filterFile: string | null;
  fileListFile: string | null;
  rotateSeconds: number | null;
  fileCount: number | null;
  dropUser: string | null;
  warnings: string[];
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
  VERSION_TEXT,
  'Usage: tcpdump [-AbdDefhHIJKlLnNOpqStuUvxX#] [ -B size ] [ -c count ] [--count]',
  '\t\t[ -C file_size ] [ -E algo:secret ] [ -F file ] [ -G seconds ]',
  '\t\t[ -i interface ] [ --immediate-mode ] [ -j tstamptype ]',
  '\t\t[ -M secret ] [ --number ] [ --print ] [ -Q in|out|inout ]',
  '\t\t[ -r file ] [ -s snaplen ] [ -T type ] [ --version ]',
  '\t\t[ -V file ] [ -w file ] [ -W filecount ] [ -y datalinktype ]',
  '\t\t[ --time-stamp-precision precision ] [ --micro ] [ --nano ]',
  '\t\t[ -z postrotate-command ] [ -Z user ] [ expression ]',
].join('\n');

const MAXIMUM_SNAPLEN = 262144;

function usageError(first: string): Invocation {
  return { kind: 'error', message: `${first}\n${USAGE_TEXT}` };
}

function atoi(value: string): number {
  const leading = /^\s*([+-]?\d+)/.exec(value);
  return leading === null ? 0 : parseInt(leading[1], 10);
}

function strtolWhole(value: string): number | null {
  const trimmed = value.replace(/^\s+/, '');
  if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(trimmed)) return parseInt(trimmed, 16);
  if (/^[+-]?0[0-7]*$/.test(trimmed)) return parseInt(trimmed, 8);
  if (/^[+-]?[1-9]\d*$/.test(trimmed)) return parseInt(trimmed, 10);
  return null;
}

const KNOWN_LINKTYPES = new Set([
  'EN10MB', 'EN3MB', 'SLIP', 'PPP', 'FDDI', 'RAW', 'NULL', 'LOOP', 'DOCSIS',
  'LINUX_SLL', 'LINUX_SLL2', 'IEEE802_11', 'PPP_SERIAL', 'C_HDLC',
]);

function defaults(): TcpdumpOptions {
  return {
    iface: 'eth0',
    count: null,
    snaplen: MAXIMUM_SNAPLEN,
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
    requestedLinkType: null,
    fileSizeLimit: null,
    filterTokens: [],
    direction: 'inout',
    absoluteSeq: false,
    skipChecksumCheck: false,
    packetNumbers: false,
    monitorMode: false,
    nanoPrecision: false,
    countOnly: false,
    printWhileWriting: false,
    foreignNumeric: false,
    stripDomain: false,
    noPromiscuous: false,
    filterFile: null,
    fileListFile: null,
    rotateSeconds: null,
    fileCount: null,
    dropUser: null,
    warnings: [],
  };
}

const SHORT_WITH_ARGUMENT = new Set(['B', 'c', 'C', 'E', 'F', 'G', 'i', 'j', 'm', 'M', 'Q', 'r', 's', 'T', 'V', 'w', 'W', 'y', 'z', 'Z']);
const SHORT_WITHOUT_ARGUMENT = new Set(['a', 'A', 'b', 'd', 'D', 'e', 'f', 'h', 'H', 'I', 'J', 'K', 'l', 'L', 'n', 'N', 'O', 'p', 'q', 'S', 't', 'u', 'U', 'v', 'x', 'X', 'Y', '#']);

interface LongOption {
  name: string;
  argument: boolean;
  short?: string;
}

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'buffer-size', argument: true, short: 'B' },
  { name: 'list-interfaces', argument: false, short: 'D' },
  { name: 'help', argument: false, short: 'h' },
  { name: 'interface', argument: true, short: 'i' },
  { name: 'monitor-mode', argument: false, short: 'I' },
  { name: 'time-stamp-type', argument: true, short: 'j' },
  { name: 'list-time-stamp-types', argument: false, short: 'J' },
  { name: 'micro', argument: false },
  { name: 'nano', argument: false },
  { name: 'time-stamp-precision', argument: true },
  { name: 'dont-verify-checksums', argument: false, short: 'K' },
  { name: 'list-data-link-types', argument: false, short: 'L' },
  { name: 'no-optimize', argument: false, short: 'O' },
  { name: 'no-promiscuous-mode', argument: false, short: 'p' },
  { name: 'direction', argument: true, short: 'Q' },
  { name: 'snapshot-length', argument: true, short: 's' },
  { name: 'absolute-tcp-sequence-numbers', argument: false, short: 'S' },
  { name: 'packet-buffered', argument: false, short: 'U' },
  { name: 'linktype', argument: true, short: 'y' },
  { name: 'immediate-mode', argument: false },
  { name: 'relinquish-privileges', argument: true, short: 'Z' },
  { name: 'count', argument: false },
  { name: 'fp-type', argument: false },
  { name: 'number', argument: false, short: '#' },
  { name: 'print', argument: false },
  { name: 'version', argument: false },
];

const PACKET_TYPES = new Set([
  'vat', 'wb', 'rpc', 'rtp', 'rtcp', 'snmp', 'cnfp', 'tftp', 'aodv', 'carp', 'radius',
  'zmtp1', 'vxlan', 'pgm', 'pgm_zmtp1', 'lmp', 'resp', 'ptp', 'someip', 'domain',
]);

const TIME_STAMP_TYPES = new Set([
  'host', 'host_lowprec', 'host_hiprec', 'adapter', 'adapter_unsynced', 'host_hiprec_unsynced',
]);

function missingBrick(option: string, brick: string): Invocation {
  return { kind: 'error', message: `tcpdump: ${option}: this simulator has no ${brick}` };
}

function resolveLongOption(written: string): LongOption | Invocation {
  const exact = LONG_OPTIONS.find((o) => o.name === written);
  if (exact) return exact;
  const candidates = LONG_OPTIONS.filter((o) => o.name.startsWith(written));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return usageError(`tcpdump: unrecognized option '--${written}'`);
  const possibilities = candidates.map((o) => `'--${o.name}'`).join(' ');
  return usageError(`tcpdump: option '--${written}' is ambiguous; possibilities: ${possibilities}`);
}

interface ParseState {
  opt: TcpdumpOptions;
  tCount: number;
  vCount: number;
  xUpper: number;
  xLower: number;
  listInterfaces: boolean;
  listLinkTypes: boolean;
}

function applyFlag(state: ParseState, ch: string): Invocation | null {
  const opt = state.opt;
  switch (ch) {
    case 't': state.tCount++; return null;
    case 'v': state.vCount++; return null;
    case 'X': state.xUpper++; return null;
    case 'x': state.xLower++; return null;
    case 'n': opt.numeric = true; return null;
    case 'N': opt.stripDomain = true; return null;
    case 'f': opt.foreignNumeric = true; return null;
    case 'p': opt.noPromiscuous = true; return null;
    case 'D': state.listInterfaces = true; return null;
    case 'L': state.listLinkTypes = true; return null;
    case 'h': return { kind: 'help', text: USAGE_TEXT };
    case 'e': opt.linkLevel = true; return null;
    case 'q': opt.quiet = true; return null;
    case 'A': opt.ascii = true; return null;
    case 'S': opt.absoluteSeq = true; return null;
    case 'K': opt.skipChecksumCheck = true; return null;
    case '#': opt.packetNumbers = true; return null;
    case 'I': opt.monitorMode = true; return null;
    case 'd': return missingBrick('-d', 'BPF code generator to dump');
    case 'J': return missingBrick('-J', 'time stamp type other than the host clock');
    case 'a': case 'b': case 'H': case 'l': case 'O': case 'u': case 'U': case 'Y':
      return null;
    default:
      return usageError(`tcpdump: invalid option -- '${ch}'`);
  }
}

function applyArgument(state: ParseState, ch: string, value: string): Invocation | null {
  const opt = state.opt;
  switch (ch) {
    case 'i':
      opt.iface = value;
      return null;
    case 'c': {
      const count = atoi(value);
      if (count <= 0) return { kind: 'error', message: `tcpdump: invalid packet count ${value}` };
      opt.count = count;
      return null;
    }
    case 's': {
      const snaplen = strtolWhole(value);
      if (snaplen === null || snaplen < 0 || snaplen > MAXIMUM_SNAPLEN) {
        return {
          kind: 'error',
          message: `tcpdump: invalid snaplen ${value} (must be >= 0 and <= ${MAXIMUM_SNAPLEN})`,
        };
      }
      opt.snaplen = snaplen === 0 ? MAXIMUM_SNAPLEN : snaplen;
      return null;
    }
    case 'y':
      if (!KNOWN_LINKTYPES.has(value.toUpperCase())) {
        return { kind: 'error', message: `tcpdump: invalid data link type ${value}` };
      }
      opt.requestedLinkType = value.toUpperCase();
      return null;
    case 'w': opt.writeFile = value; return null;
    case 'r': opt.readFile = value; return null;
    case 'V': opt.fileListFile = value; return null;
    case 'F': opt.filterFile = value; return null;
    case 'Z': opt.dropUser = value; return null;
    case 'B':
      if (atoi(value) * 1024 <= 0) return { kind: 'error', message: `tcpdump: invalid packet buffer size ${value}` };
      return null;
    case 'C': {
      const size = /^\s*[+-]?\d+$/.test(value) ? parseInt(value, 10) : null;
      if (size === null || size <= 0) return { kind: 'error', message: `tcpdump: invalid file size ${value}` };
      opt.fileSizeLimit = size;
      return null;
    }
    case 'G': {
      const seconds = atoi(value);
      if (seconds < 0) return { kind: 'error', message: `tcpdump: invalid number of seconds ${value}` };
      opt.rotateSeconds = seconds;
      return null;
    }
    case 'W': {
      const files = atoi(value);
      if (files <= 0) return { kind: 'error', message: `tcpdump: invalid number of output files ${value}` };
      opt.fileCount = files;
      return null;
    }
    case 'Q': {
      const direction = value.toLowerCase();
      if (direction !== 'in' && direction !== 'out' && direction !== 'inout') {
        return { kind: 'error', message: `tcpdump: unknown capture direction \`${value}'` };
      }
      opt.direction = direction;
      return null;
    }
    case 'm':
      opt.warnings.push(`tcpdump: ignoring option \`-m ${value}' (no libsmi support)`);
      return null;
    case 'T':
      if (!PACKET_TYPES.has(value.toLowerCase())) {
        return { kind: 'error', message: `tcpdump: unknown packet type \`${value}'` };
      }
      return missingBrick(`-T ${value}`, `${value.toLowerCase()} printer`);
    case 'j':
      if (!TIME_STAMP_TYPES.has(value.toLowerCase())) {
        return { kind: 'error', message: `tcpdump: invalid time stamp type ${value}` };
      }
      return value.toLowerCase() === 'host'
        ? null : missingBrick(`-j ${value}`, 'time stamp type other than the host clock');
    case 'E': return missingBrick('-E', 'ESP decryption');
    case 'M': return missingBrick('-M', 'TCP-MD5 signature verification');
    case 'z': return missingBrick('-z', 'post-rotate command runner');
    default:
      return usageError(`tcpdump: invalid option -- '${ch}'`);
  }
}

function applyLong(state: ParseState, option: LongOption, value: string | undefined): Invocation | null {
  if (option.short !== undefined) {
    return option.argument ? applyArgument(state, option.short, value!) : applyFlag(state, option.short);
  }
  const opt = state.opt;
  switch (option.name) {
    case 'micro': opt.nanoPrecision = false; return null;
    case 'nano': opt.nanoPrecision = true; return null;
    case 'time-stamp-precision': {
      const precision = value!.toLowerCase();
      if (precision !== 'micro' && precision !== 'nano') {
        return { kind: 'error', message: 'tcpdump: unsupported time stamp precision' };
      }
      opt.nanoPrecision = precision === 'nano';
      return null;
    }
    case 'immediate-mode': return null;
    case 'count': opt.countOnly = true; return null;
    case 'print': opt.printWhileWriting = true; return null;
    case 'version': return { kind: 'version', text: VERSION_TEXT };
    case 'fp-type': return missingBrick('--fp-type', 'floating-point arithmetic probe');
    default: return null;
  }
}

export function parseInvocation(tokens: string[]): Invocation {
  const state: ParseState = {
    opt: defaults(), tCount: 0, vCount: 0, xUpper: 0, xLower: 0,
    listInterfaces: false, listLinkTypes: false,
  };
  const opt = state.opt;
  const filter: string[] = [];
  let optionsEnded = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (optionsEnded || token === '-' || !token.startsWith('-')) {
      if (token !== '') filter.push(token);
      continue;
    }
    if (token === '--') { optionsEnded = true; continue; }

    if (token.startsWith('--')) {
      const [written, inline] = token.slice(2).split(/=(.*)/s, 2);
      const option = resolveLongOption(written);
      if ('kind' in option) return option;
      let value = inline;
      if (option.argument && value === undefined) {
        value = tokens[++i];
        if (value === undefined) return usageError(`tcpdump: option '--${option.name}' requires an argument`);
      }
      if (!option.argument && inline !== undefined) {
        return usageError(`tcpdump: option '--${option.name}' doesn't allow an argument`);
      }
      const outcome = applyLong(state, option, value);
      if (outcome) return outcome;
      continue;
    }

    const cluster = token.slice(1);
    for (let c = 0; c < cluster.length; c++) {
      const ch = cluster[c];
      if (SHORT_WITH_ARGUMENT.has(ch)) {
        const glued = cluster.slice(c + 1);
        const value = glued !== '' ? glued : tokens[++i];
        if (value === undefined) return usageError(`tcpdump: option requires an argument -- '${ch}'`);
        const outcome = applyArgument(state, ch, value);
        if (outcome) return outcome;
        break;
      }
      if (!SHORT_WITHOUT_ARGUMENT.has(ch)) return usageError(`tcpdump: invalid option -- '${ch}'`);
      const outcome = applyFlag(state, ch);
      if (outcome) return outcome;
    }
  }

  if (opt.foreignNumeric && (opt.readFile !== null || opt.fileListFile !== null)) {
    return { kind: 'error', message: 'tcpdump: -f can not be used with -V or -r' };
  }
  if (opt.fileListFile !== null && opt.readFile !== null) {
    return { kind: 'error', message: 'tcpdump: -V and -r are mutually exclusive.' };
  }
  if (state.listInterfaces) return { kind: 'list-interfaces' };

  const modes: TimestampMode[] = ['time', 'none', 'epoch', 'delta', 'datetime', 'since-first'];
  opt.tsMode = state.tCount < modes.length ? modes[state.tCount] : 'none';
  opt.verbose = state.vCount;
  if (state.xUpper > 0) { opt.hex = 'hexascii'; opt.hexLink = state.xUpper >= 2; }
  else if (state.xLower > 0) { opt.hex = 'hex'; opt.hexLink = state.xLower >= 2; }
  if (state.listLinkTypes) return { kind: 'list-link-types', iface: opt.iface };

  opt.filterTokens = expandFilterTokens(filter);
  return { kind: 'capture', options: opt };
}

export function expandFilterTokens(filter: string[]): string[] {
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

export interface CaptureDevice {
  name: string;
  up: boolean;
  carrier: boolean;
}

interface ListedDevice {
  label: string;
  up: boolean;
  running: boolean;
  loopback: boolean;
  any: boolean;
  connection: 'Connected' | 'Disconnected' | null;
}

function listedDeviceOf(device: CaptureDevice): ListedDevice {
  return {
    label: device.name,
    up: device.up,
    running: device.up && device.carrier,
    loopback: false,
    any: false,
    connection: device.carrier && device.up ? 'Connected' : 'Disconnected',
  };
}

function figureOfMerit(device: ListedDevice): number {
  let merit = 0;
  if (!device.running) merit += 0x80000000;
  if (!device.up) merit += 0x40000000;
  if (device.connection === 'Disconnected') merit += 0x20000000;
  if (device.loopback) merit += 0x10000000;
  if (device.any) merit += 0x08000000;
  return merit;
}

function listedFlags(device: ListedDevice): string {
  const status: string[] = [];
  if (device.up) status.push('Up');
  if (device.running) status.push('Running');
  if (device.loopback) status.push('Loopback');
  const text = status.length === 0 ? 'none' : status.join(', ');
  return device.connection === null ? text : `${text}, ${device.connection}`;
}

export function listInterfacesText(devices: readonly CaptureDevice[]): string {
  const listed: ListedDevice[] = [
    ...devices.filter((d) => d.name !== 'lo').map(listedDeviceOf),
    {
      label: 'any (Pseudo-device that captures on all interfaces)',
      up: true, running: true, loopback: false, any: true, connection: null,
    },
    { label: 'lo', up: true, running: true, loopback: true, any: false, connection: null },
  ];
  const ordered = listed
    .map((device, position) => ({ device, position }))
    .sort((a, b) => figureOfMerit(a.device) - figureOfMerit(b.device) || a.position - b.position);
  return ordered
    .map(({ device }, idx) => `${idx + 1}.${device.label} [${listedFlags(device)}]`)
    .join('\n');
}


import { IPAddress } from '@/network/core/types';
import { noFlags, type TcpFlags } from '@/network/tcp/types';
import type { NssServiceEntry } from '@/network/devices/linux/nss/types';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

type Mode = 'tcp' | 'icmp' | 'udp' | 'rawip' | 'scan';
type DestPortStep = 'fixed' | 'on-reply' | 'always';

const DEFAULT_TTL = 64;
const DEFAULT_SRCWINSIZE = 512;
const DEFAULT_VIRTUAL_MTU = 16;
const IPHDR_SIZE = 20;
const TCPHDR_SIZE = 20;
const UDPHDR_SIZE = 8;
const ICMPHDR_SIZE = 8;
const IPPROTO_RAW = 0;
const ICMP_TYPE_TIME_EXCEEDED = 11;
const MAXPORT = 65535;
const RELEASE_VERSION = '3.0.0-alpha-1';
const RELEASE_DATE = '$Id: release.h,v 1.4 2004/04/09 23:38:56 antirez Exp $';

interface Hping3Args {
  target: string;
  count: number;
  destPort: number;
  baseSourcePort: number;
  mode: Mode;
  flags: TcpFlags;
  spoof?: string;
  ttl: number;
  dataSize: number;
  fragmentMtu?: number;
  window: number;
  ipProto: number;
  tos?: number;
  ipId?: number;
  setSequence?: number;
  setAck?: number;
  keepSourcePort: boolean;
  destPortStep: DestPortStep;
  flood: boolean;
  quiet: boolean;
  verbose: boolean;
  seqnumOnly: boolean;
  scanPorts?: string;
  showUsage: boolean;
  showVersion: boolean;
  showTosHelp: boolean;
  error?: string;
}

const FLAG_LETTERS: ReadonlyArray<[keyof TcpFlags, string]> = [
  ['rst', 'R'], ['syn', 'S'], ['ack', 'A'], ['fin', 'F'], ['psh', 'P'], ['urg', 'U'],
];

const SCAN_FLAG_TABLE: ReadonlyArray<[keyof TcpFlags, string]> = [
  ['fin', 'F'], ['syn', 'S'], ['rst', 'R'], ['psh', 'P'], ['ack', 'A'], ['urg', 'Y'],
];

const TOS_HELP = [
  'tos help:',
  '          TOS Name                Hex Value           Typical Uses',
  '',
  '       Minimum Delay                 10               ftp, telnet',
  '       Maximum Throughput            08               ftp-data',
  '       Maximum Reliability           04               snmp',
  '       Minimum Cost                  02               nntp',
].join('\n');

const USAGE = [
  'usage: hping host [options]',
  '  -h  --help      show this help',
  '  -v  --version   show version',
  '  -c  --count     packet count',
  '  -i  --interval  wait (uX for X microseconds, for example -i u1000)',
  '      --fast      alias for -i u10000 (10 packets for second)',
  '      --faster    alias for -i u1000 (100 packets for second)',
  "      --flood\t   sent packets as fast as possible. Don't show replies.",
  '  -n  --numeric   numeric output',
  '  -q  --quiet     quiet',
  '  -I  --interface interface name (otherwise default routing interface)',
  '  -V  --verbose   verbose mode',
  'Mode',
  '  default mode     TCP',
  '  -0  --rawip      RAW IP mode',
  '  -1  --icmp       ICMP mode',
  '  -2  --udp        UDP mode',
  '  -8  --scan       SCAN mode.',
  '                   Example: hping --scan 1-30,70-90 -S www.target.host',
  'IP',
  '  -a  --spoof      spoof source address',
  '  -t  --ttl        ttl (default 64)',
  '  -N  --id         id (default random)',
  '  -f  --frag       split packets in more frag.  (may pass weak acl)',
  '  -m  --mtu        set virtual mtu, implies --frag if packet size > mtu',
  '  -o  --tos        type of service (default 0x00), try --tos help',
  '  -H  --ipproto    set the IP protocol field, only in RAW IP mode',
  'UDP/TCP',
  '  -s  --baseport   base source port             (default random)',
  '  -p  --destport   [+][+]<port> destination port(default 0)',
  '  -k  --keep       keep still source port',
  '  -w  --win        winsize (default 64)',
  '  -Q  --seqnum     shows only tcp sequence number',
  '  -b  --badcksum   (try to) send packets with a bad IP checksum',
  '  -M  --setseq     set TCP sequence number',
  '  -L  --setack     set TCP ack',
  '  -F  --fin        set FIN flag',
  '  -S  --syn        set SYN flag',
  '  -R  --rst        set RST flag',
  '  -P  --push       set PUSH flag',
  '  -A  --ack        set ACK flag',
  '  -U  --urg        set URG flag',
  'Common',
  '  -d  --data       data size                    (default is 0)',
].join('\n');

function parseArgs(args: readonly string[]): Hping3Args {
  const out: Hping3Args = {
    target: '', count: Infinity, destPort: 0, baseSourcePort: (Date.now() & 0xffff) || 1024,
    mode: 'tcp', flags: noFlags(), ttl: DEFAULT_TTL, dataSize: 0,
    window: DEFAULT_SRCWINSIZE, ipProto: IPPROTO_RAW,
    keepSourcePort: false, destPortStep: 'fixed', flood: false, quiet: false,
    verbose: false, seqnumOnly: false,
    showUsage: false, showVersion: false, showTosHelp: false,
  };
  const takeNumber = (value: string | undefined, name: string): number => {
    const n = Number(value);
    if (value === undefined || !Number.isFinite(n)) {
      out.error = `hping3: option ${name} needs a numeric argument`;
      return NaN;
    }
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '-h': case '--help': out.showUsage = true; return out;
      case '-v': case '--version': out.showVersion = true; return out;
      case '-c': case '--count': out.count = takeNumber(args[++i], '-c'); break;
      case '-p': case '--destport': {
        let spec = args[++i] ?? '';
        if (spec.startsWith('+')) { out.destPortStep = 'on-reply'; spec = spec.slice(1); }
        if (spec.startsWith('+')) { out.destPortStep = 'always'; spec = spec.slice(1); }
        out.destPort = takeNumber(spec, '-p');
        break;
      }
      case '-s': case '--baseport': out.baseSourcePort = takeNumber(args[++i], '-s'); break;
      case '-d': case '--data': out.dataSize = takeNumber(args[++i], '-d'); break;
      case '-t': case '--ttl': out.ttl = takeNumber(args[++i], '-t'); break;
      case '-w': case '--win': out.window = takeNumber(args[++i], '-w'); break;
      case '-N': case '--id': out.ipId = takeNumber(args[++i], '-N'); break;
      case '-M': case '--setseq': out.setSequence = takeNumber(args[++i], '-M'); break;
      case '-L': case '--setack': out.setAck = takeNumber(args[++i], '-L'); break;
      case '-o': case '--tos': {
        const spec = args[++i] ?? '';
        if (spec === 'help') { out.showTosHelp = true; return out; }
        const n = Number(spec.startsWith('0x') ? spec : `0x${spec}`);
        if (!Number.isFinite(n)) { out.error = 'hping3: option -o needs a numeric argument'; return out; }
        out.tos = n;
        break;
      }
      case '-H': case '--ipproto': out.ipProto = takeNumber(args[++i], '--ipproto'); break;
      case '-m': case '--mtu': out.fragmentMtu = takeNumber(args[++i], '-m'); break;
      case '-a': case '--spoof': out.spoof = args[++i]; break;
      case '-k': case '--keep': out.keepSourcePort = true; break;
      case '--flood': out.flood = true; break;
      case '-1': case '--icmp': out.mode = 'icmp'; break;
      case '-2': case '--udp': out.mode = 'udp'; break;
      case '-0': case '--rawip': out.mode = 'rawip'; break;
      case '-8': case '--scan': out.mode = 'scan'; out.scanPorts = args[++i]; break;
      case '-S': case '--syn': out.flags.syn = true; break;
      case '-A': case '--ack': out.flags.ack = true; break;
      case '-R': case '--rst': out.flags.rst = true; break;
      case '-F': case '--fin': out.flags.fin = true; break;
      case '-P': case '--push': out.flags.psh = true; break;
      case '-U': case '--urg': out.flags.urg = true; break;
      case '-f': case '--frag': out.fragmentMtu ??= DEFAULT_VIRTUAL_MTU; break;
      case '-Q': case '--seqnum': out.seqnumOnly = true; break;
      case '-i': case '--interval': i++; break;
      case '--fast': case '--faster': break;
      case '-q': case '--quiet': out.quiet = true; break;
      case '-V': case '--verbose': out.verbose = true; break;
      case '-n': case '--numeric': break;
      default:
        if (a.startsWith('-')) { out.error = `hping3: unknown option ${a}`; return out; }
        out.target = a;
    }
  }
  if (out.target === '') out.error = 'hping3: no host to target, try --help';
  if (out.mode === 'scan' && (out.scanPorts ?? '') === '') {
    out.error = 'Ports syntax error for scan mode';
  }
  return out;
}

function setFlagsLabel(parsed: Hping3Args): string {
  if (parsed.mode === 'rawip') return 'raw IP mode';
  if (parsed.mode === 'icmp') return 'icmp mode';
  if (parsed.mode === 'udp') return 'udp mode';
  const label = FLAG_LETTERS.filter(([key]) => parsed.flags[key]).map(([, letter]) => letter).join('');
  return label.length > 0 ? label : 'NO FLAGS are';
}

function headerBytes(mode: Mode): number {
  if (mode === 'rawip') return IPHDR_SIZE;
  if (mode === 'udp') return IPHDR_SIZE + UDPHDR_SIZE;
  if (mode === 'icmp') return IPHDR_SIZE + ICMPHDR_SIZE;
  return IPHDR_SIZE + TCPHDR_SIZE;
}

function replyFlagLetters(flags: TcpFlags): string {
  const label = FLAG_LETTERS.filter(([key]) => flags[key]).map(([, letter]) => letter).join('');
  return label.length > 0 ? label : 'none';
}

function scanFlagColumn(flags: TcpFlags): string {
  const cells = ['.', '.', '.', '.', '.', '.', '.', '.'];
  SCAN_FLAG_TABLE.forEach(([key, letter], bit) => { if (flags[key]) cells[bit] = letter; });
  return cells.join('');
}

function egressFor(ctx: LinuxCommandContext, target: IPAddress): { iface: string; ip: string } | null {
  let best: { iface: string; ip: string; prefix: number } | null = null;
  const value = target.toUint32();
  for (const route of ctx.net.getRoutingTable()) {
    const mask = route.mask.toUint32();
    if (((value & mask) >>> 0) !== ((route.network.toUint32() & mask) >>> 0)) continue;
    const prefix = route.mask.toCIDR();
    if (best && prefix <= best.prefix) continue;
    const port = ctx.net.getPorts().get(route.iface);
    const ip = port?.getIPAddress()?.toString();
    if (ip) best = { iface: route.iface, ip, prefix };
  }
  return best;
}

function serviceName(ctx: LinuxCommandContext, port: number): string {
  const found = ctx.executor.nss.lookup<NssServiceEntry>(
    'services', (s) => s.getservbyport?.(port, 'tcp'));
  return found.status === 'SUCCESS' && found.entry ? found.entry.name : String(port);
}

function knownPorts(ctx: LinuxCommandContext): number[] {
  const all = ctx.executor.nss.enumerate<NssServiceEntry>('services', (s) => s.enumServices?.());
  const ports = new Set<number>();
  for (const entry of all.entries) {
    if (entry.port >= 0 && entry.port <= MAXPORT) ports.add(entry.port);
  }
  return [...ports];
}

function parseScanPorts(ctx: LinuxCommandContext, spec: string): number[] | null {
  const active = new Set<number>();
  for (const rawItem of spec.split(',')) {
    let item = rawItem;
    const negated = item.startsWith('!');
    if (negated) item = item.slice(1);
    const apply = (ports: Iterable<number>): void => {
      for (const p of ports) { if (negated) active.delete(p); else active.add(p); }
    };
    if (item === 'all') {
      apply(Array.from({ length: MAXPORT + 1 }, (_, i) => i));
    } else if (item === 'known') {
      apply(knownPorts(ctx));
    } else if (item.includes('-')) {
      const [lowText, highText] = item.split('-');
      const low = Number(lowText);
      const high = Number(highText);
      if (!Number.isInteger(low) || !Number.isInteger(high)) return null;
      const from = Math.min(low, high);
      const to = Math.max(low, high);
      if (from < 0 || to > MAXPORT) return null;
      apply(Array.from({ length: to - from + 1 }, (_, i) => from + i));
    } else {
      const port = Number(item);
      if (!Number.isInteger(port) || port < 0 || port > MAXPORT) return null;
      apply([port]);
    }
  }
  return [...active].sort((a, b) => a - b);
}

interface Emission {
  received: boolean;
  lines?: string[];
}

function probePayload(size: number): Uint8Array | undefined {
  return size > 0 ? new Uint8Array(size) : undefined;
}

function tcpProbeShape(parsed: Hping3Args, sourcePort: number): Parameters<
  ReturnType<LinuxCommandContext['net']['getTcpStack']>['scanProbeDetail']>[3] {
  return {
    sourcePort,
    sourceIp: parsed.spoof,
    ttl: parsed.ttl,
    fragmentMtu: parsed.fragmentMtu,
    window: parsed.window,
    payload: probePayload(parsed.dataSize),
    ...(parsed.tos === undefined ? {} : { tos: parsed.tos }),
    ...(parsed.ipId === undefined ? {} : { identification: parsed.ipId }),
    ...(parsed.setSequence === undefined ? {} : { sequence: parsed.setSequence }),
    ...(parsed.setAck === undefined ? {} : { acknowledgement: parsed.setAck }),
  };
}

interface ReplyIpFields {
  totalLength: number;
  ttl: number;
  identification: number;
  tos: number;
  dontFragment: boolean;
}

const ICMP_UNREACH_MESSAGES: ReadonlyArray<string | null> = [
  'Network Unreachable from',
  'Host Unreachable from',
  'Protocol Unreachable from',
  'Port Unreachable from',
  'Fragmentation Needed/DF set from',
  'Source Route failed from',
  null, null, null, null, null, null, null,
  'Packet filtered from',
  'Precedence violation from',
  'precedence cut off from',
];

const ICMP_EXC_MESSAGES: ReadonlyArray<string | null> = [
  'TTL 0 during transit from',
  'TTL 0 during reassembly from',
];

function icmpErrorLine(
  detail: { icmpType?: number; icmpCode?: number; icmpFrom?: string },
  target: string,
): string | null {
  const from = detail.icmpFrom ?? target;
  if (detail.icmpType === ICMP_TYPE_TIME_EXCEEDED) {
    const text = ICMP_EXC_MESSAGES[detail.icmpCode ?? 0];
    return text === undefined || text === null ? null : `${text} ip=${from}`;
  }
  const text = ICMP_UNREACH_MESSAGES[detail.icmpCode ?? 3];
  return text === undefined || text === null ? null : `ICMP ${text} ip=${from}`;
}

function ipPartLines(fields: ReplyIpFields, ip: string, verbose: boolean): string[] {
  const head = `len=${fields.totalLength} ip=${ip} ttl=${fields.ttl} `
    + `${fields.dontFragment ? 'DF ' : ''}id=${fields.identification} `;
  return verbose ? [`${head}tos=${fields.tos.toString(16)} iplen=${fields.totalLength}`] : [head];
}

function appendToLast(lines: string[], text: string): string[] {
  if (lines.length === 0) return [text];
  const out = lines.slice(0, -1);
  out.push(`${lines[lines.length - 1]}${text}`);
  return out;
}

function tcpEmission(
  ctx: LinuxCommandContext, parsed: Hping3Args,
  sourcePort: number, destPort: number, seq: number, target: IPAddress,
  previousSequence: { value: number },
): Emission {
  const detail = ctx.net.getTcpStack().scanProbeDetail(
    parsed.target, destPort, parsed.flags, tcpProbeShape(parsed, sourcePort));
  const ip = target.toString();
  if (detail.reply === 'syn-ack' || detail.reply === 'rst' || detail.reply === 'rst-window') {
    if (parsed.seqnumOnly) {
      const diff = (detail.sequence >= previousSequence.value
        ? detail.sequence - previousSequence.value
        : (0xffffffff - previousSequence.value) + detail.sequence) >>> 0;
      previousSequence.value = detail.sequence;
      return {
        received: true,
        lines: [`${String(detail.sequence).padStart(10, ' ')} +${diff}`],
      };
    }
    const protocolPart = `sport=${destPort} flags=${replyFlagLetters(detail.flags)} `
      + `seq=${seq} win=${detail.window} rtt=0.0 ms`;
    const ipPart = ipPartLines(detail, ip, parsed.verbose);
    const lines = parsed.verbose
      ? [...ipPart, protocolPart,
        `seq=${detail.sequence} ack=${detail.acknowledgement} `
          + `sum=${detail.checksum.toString(16)} urp=${detail.urgentPointer}`,
        '']
      : appendToLast(ipPart, protocolPart);
    return { received: true, lines };
  }
  if (detail.reply === 'icmp-prohibited' || detail.reply === 'icmp-unreachable') {
    const line = icmpErrorLine(detail, ip);
    return line === null ? { received: false } : { received: false, lines: [line] };
  }
  return { received: false };
}

async function icmpEmission(
  ctx: LinuxCommandContext, parsed: Hping3Args, seq: number, target: IPAddress,
): Promise<Emission> {
  if (parsed.spoof !== undefined) {
    ctx.net.sendCraftedIcmpEcho(target, {
      sourceIp: new IPAddress(parsed.spoof), ttl: parsed.ttl, dataSize: parsed.dataSize,
    });
    return { received: false };
  }
  const results = await ctx.net.pingSequence(target, 1, 1000, parsed.ttl, {
    dataSize: parsed.dataSize,
  });
  const answer = results.find((r) => r.success);
  if (!answer) return { received: false };
  const ipPart = ipPartLines({
    totalLength: answer.ipLen ?? headerBytes('icmp') + parsed.dataSize,
    ttl: answer.ttl,
    identification: answer.ipId ?? 0,
    tos: answer.tos ?? 0,
    dontFragment: false,
  }, target.toString(), parsed.verbose);
  const protocolPart = `icmp_seq=${seq} rtt=${answer.rttMs.toFixed(1)} ms`;
  const lines = parsed.verbose
    ? [...ipPart, protocolPart]
    : appendToLast(ipPart, protocolPart);
  return { received: true, lines };
}

function udpEmission(
  ctx: LinuxCommandContext, parsed: Hping3Args,
  sourcePort: number, destPort: number, target: IPAddress,
): Emission {
  ctx.net.sendUdpProbe(target, destPort, sourcePort, {
    ttl: parsed.ttl,
    ...(parsed.spoof === undefined ? {} : { sourceIp: new IPAddress(parsed.spoof) }),
    ...(parsed.dataSize > 0 ? { payload: new Uint8Array(parsed.dataSize) } : {}),
  });
  return { received: false };
}

function rawIpEmission(
  ctx: LinuxCommandContext, parsed: Hping3Args, target: IPAddress,
): Emission {
  ctx.net.sendRawIpPacket(target, parsed.ipProto, {
    ttl: parsed.ttl,
    ...(parsed.spoof === undefined ? {} : { sourceIp: new IPAddress(parsed.spoof) }),
    ...(parsed.dataSize > 0 ? { dataSize: parsed.dataSize } : {}),
  });
  return { received: false };
}

function lossRate(sent: number, received: number): number {
  if (sent === 0) return 0;
  if (received === 0) return 100;
  return 100 - Math.floor((received * 100) / sent);
}

function scanMain(
  ctx: LinuxCommandContext, parsed: Hping3Args, target: IPAddress,
): string {
  const ports = parseScanPorts(ctx, parsed.scanPorts ?? '');
  if (ports === null) return 'Ports syntax error for scan mode';
  const lines = [
    `${ports.length} ports to scan, use -V to see all the replies`,
    '+----+-----------+---------+---+-----+-----+-----+',
    '|port| serv name |  flags  |ttl| id  | win | len |',
    '+----+-----------+---------+---+-----+-----+-----+',
  ];
  const silent: number[] = [];
  const stack = ctx.net.getTcpStack();
  for (const port of ports) {
    const detail = stack.scanProbeDetail(parsed.target, port, parsed.flags,
      tcpProbeShape(parsed, parsed.baseSourcePort));
    if (detail.reply === 'none') { silent.push(port); continue; }
    if (detail.reply === 'icmp-prohibited' || detail.reply === 'icmp-unreachable') {
      lines.push(`${String(port).padStart(5, ' ')}:                      `
        + `${String(detail.ttl).padStart(3, ' ')} `
        + `${String(detail.totalLength).padStart(5, ' ')} `
        + `${String(detail.identification).padStart(5, ' ')}   `
        + `(ICMP   3   ${detail.reply === 'icmp-prohibited' ? 13 : 3} `
        + `from ${target.toString()})`);
      continue;
    }
    if (!detail.flags.syn && !parsed.verbose) continue;
    lines.push(`${String(port).padStart(5, ' ')} `
      + `${serviceName(ctx, port).slice(0, 11).padEnd(11, ' ')}: `
      + `${scanFlagColumn(detail.flags)} `
      + `${String(detail.ttl).padStart(3, ' ')} `
      + `${String(detail.identification).padStart(5, ' ')} `
      + `${String(detail.window).padStart(5, ' ')} `
      + `${String(detail.totalLength).padStart(5, ' ')}`);
  }
  lines.push('All replies received. Done.');
  lines.push('Not responding ports: '
    + silent.map((p) => `(${p} ${serviceName(ctx, p).slice(0, 11)}) `).join(''));
  return lines.join('\n');
}

async function runHping3(ctx: LinuxCommandContext, args: readonly string[]): Promise<string> {
  const parsed = parseArgs(args);
  if (parsed.showUsage) return USAGE;
  if (parsed.showTosHelp) return TOS_HELP;
  if (parsed.showVersion) {
    return `hping version ${RELEASE_VERSION} (${RELEASE_DATE})\n`
      + 'NO TCL scripting support compiled in';
  }
  if (parsed.error) return parsed.error;

  const target = await ctx.net.resolveHostname(parsed.target);
  if (!target) return `hping3: bad address '${parsed.target}'`;

  const egress = egressFor(ctx, target);
  if (!egress) return `[open_sockraw] socket(): no route to ${target.toString()}`;

  if (parsed.mode === 'scan') return scanMain(ctx, parsed, target);

  const lines: string[] = [];
  lines.push(`HPING ${parsed.target} (${egress.iface} ${target.toString()}): `
    + `${setFlagsLabel(parsed)} set, ${headerBytes(parsed.mode)} headers + ${parsed.dataSize} data bytes`);
  if (parsed.flood) lines.push('hping in flood mode, no replies will be shown');

  const count = Number.isFinite(parsed.count) ? parsed.count : 1;
  const previousSequence = { value: 0 };
  let received = 0;
  let destPort = parsed.destPort;
  for (let seq = 0; seq < count; seq++) {
    const sourcePort = parsed.keepSourcePort
      ? parsed.baseSourcePort
      : (parsed.baseSourcePort + seq) & 0xffff;
    let emission: Emission;
    switch (parsed.mode) {
      case 'icmp': emission = await icmpEmission(ctx, parsed, seq, target); break;
      case 'udp': emission = udpEmission(ctx, parsed, sourcePort, destPort, target); break;
      case 'rawip': emission = rawIpEmission(ctx, parsed, target); break;
      default:
        emission = tcpEmission(
          ctx, parsed, sourcePort, destPort, seq, target, previousSequence);
    }
    if (emission.received) received++;
    if (emission.lines !== undefined && !parsed.flood && !parsed.quiet) {
      lines.push(...emission.lines);
    }
    if (parsed.destPortStep === 'always') destPort = (destPort + 1) & 0xffff;
    else if (parsed.destPortStep === 'on-reply' && emission.received) {
      destPort = (destPort + 1) & 0xffff;
    }
  }

  lines.push('');
  lines.push(`--- ${parsed.target} hping statistic ---`);
  lines.push(`${count} packets transmitted, ${received} packets received, `
    + `${lossRate(count, received)}% packet loss`);
  lines.push('round-trip min/avg/max = 0.0/0.0/0.0 ms');
  return lines.join('\n');
}

export const hping3Command: LinuxCommand = {
  name: 'hping3',
  aliases: ['hping', 'hping2'],
  package: 'hping3',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'hping3 [-c count] [-p [+[+]]destport] [-s baseport] [-k] [-1|-2|-0|-8 ports] '
    + '[-S|-A|-R|-F|-P|-U] [-a spoofaddr] [-t ttl] [-w win] [-d datasize] [-o tos] '
    + '[-N id] [-M seq] [-L ack] [-Q] [-V] [-f] [-m mtu] [--flood] host',
  help: 'Send custom TCP/IP packets and display target replies.',
  helpText: USAGE,
  run: (ctx, args) => runHping3(ctx, args),
};

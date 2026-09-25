import { IPAddress } from '@/network/core/types';
import { noFlags, type TcpFlags } from '@/network/tcp/types';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

type Mode = 'tcp' | 'icmp' | 'udp' | 'rawip';
type DestPortStep = 'fixed' | 'on-reply' | 'always';

const DEFAULT_TTL = 64;
const DEFAULT_SRCWINSIZE = 512;
const IPHDR_SIZE = 20;
const TCPHDR_SIZE = 20;
const UDPHDR_SIZE = 8;
const ICMPHDR_SIZE = 8;
const IPPROTO_RAW = 0;

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
  keepSourcePort: boolean;
  destPortStep: DestPortStep;
  flood: boolean;
  quiet: boolean;
  error?: string;
}

const FLAG_LETTERS: ReadonlyArray<[keyof TcpFlags, string]> = [
  ['rst', 'R'], ['syn', 'S'], ['ack', 'A'], ['fin', 'F'], ['psh', 'P'], ['urg', 'U'],
];

function parseArgs(args: readonly string[]): Hping3Args {
  const out: Hping3Args = {
    target: '', count: Infinity, destPort: 0, baseSourcePort: (Date.now() & 0xffff) || 1024,
    mode: 'tcp', flags: noFlags(), ttl: DEFAULT_TTL, dataSize: 0,
    window: DEFAULT_SRCWINSIZE, ipProto: IPPROTO_RAW,
    keepSourcePort: false, destPortStep: 'fixed', flood: false, quiet: false,
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
      case '--ipproto': out.ipProto = takeNumber(args[++i], '--ipproto'); break;
      case '--mtu': out.fragmentMtu = takeNumber(args[++i], '--mtu'); break;
      case '-a': case '--spoof': out.spoof = args[++i]; break;
      case '-k': case '--keep': out.keepSourcePort = true; break;
      case '--flood': out.flood = true; break;
      case '-1': case '--icmp': out.mode = 'icmp'; break;
      case '-2': case '--udp': out.mode = 'udp'; break;
      case '-0': case '--rawip': out.mode = 'rawip'; break;
      case '-S': case '--syn': out.flags.syn = true; break;
      case '-A': case '--ack': out.flags.ack = true; break;
      case '-R': case '--rst': out.flags.rst = true; break;
      case '-F': case '--fin': out.flags.fin = true; break;
      case '-P': case '--push': out.flags.psh = true; break;
      case '-U': case '--urg': out.flags.urg = true; break;
      case '-f': case '--frag': break;
      case '-i': case '--interval': i++; break;
      case '-q': case '--quiet': out.quiet = true; break;
      case '-n': case '-V': case '--verbose': break;
      default:
        if (a.startsWith('-')) { out.error = `hping3: unknown option ${a}`; return out; }
        out.target = a;
    }
  }
  if (out.target === '') out.error = 'hping3: no host to target, try --help';
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
  if (mode === 'tcp') return IPHDR_SIZE + TCPHDR_SIZE;
  if (mode === 'udp') return IPHDR_SIZE + UDPHDR_SIZE;
  return IPHDR_SIZE + ICMPHDR_SIZE;
}

function replyFlagLetters(reply: 'syn-ack' | 'rst' | 'rst-window'): string {
  return reply === 'syn-ack' ? 'SA' : 'RA';
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

function ipPrefix(len: number, ip: string, ttl: number, id: number): string {
  return `len=${len} ip=${ip} ttl=${ttl} id=${id} `;
}

interface Emission {
  received: boolean;
  line?: string;
}

function tcpEmission(
  ctx: LinuxCommandContext, parsed: Hping3Args,
  sourcePort: number, destPort: number, seq: number, target: IPAddress,
): Emission {
  const detail = ctx.net.getTcpStack().scanProbeDetail(parsed.target, destPort, parsed.flags, {
    sourcePort,
    sourceIp: parsed.spoof,
    ttl: parsed.ttl,
    fragmentMtu: parsed.fragmentMtu,
    window: parsed.window,
  });
  const ip = target.toString();
  if (detail.reply === 'syn-ack' || detail.reply === 'rst' || detail.reply === 'rst-window') {
    const len = headerBytes('tcp');
    return {
      received: true,
      line: ipPrefix(len, ip, DEFAULT_TTL, seq)
        + `sport=${destPort} flags=${replyFlagLetters(detail.reply)} seq=${seq} `
        + `win=${detail.window} rtt=0.0 ms`,
    };
  }
  if (detail.reply === 'icmp-prohibited') {
    return { received: false, line: `ICMP Packet filtered from ip=${ip}` };
  }
  if (detail.reply === 'icmp-unreachable') {
    return { received: false, line: `ICMP Port Unreachable from ip=${ip}` };
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
  const len = headerBytes('icmp') + parsed.dataSize;
  return {
    received: true,
    line: ipPrefix(len, target.toString(), answer.ttl, seq)
      + `icmp_seq=${seq} rtt=${answer.rttMs.toFixed(1)} ms`,
  };
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

async function runHping3(ctx: LinuxCommandContext, args: readonly string[]): Promise<string> {
  const parsed = parseArgs(args);
  if (parsed.error) return parsed.error;

  const target = await ctx.net.resolveHostname(parsed.target);
  if (!target) return `hping3: bad address '${parsed.target}'`;

  const egress = egressFor(ctx, target);
  if (!egress) return `[open_sockraw] socket(): no route to ${target.toString()}`;

  const lines: string[] = [];
  lines.push(`HPING ${parsed.target} (${egress.iface} ${target.toString()}): `
    + `${setFlagsLabel(parsed)} set, ${headerBytes(parsed.mode)} headers + ${parsed.dataSize} data bytes`);
  if (parsed.flood) lines.push('hping in flood mode, no replies will be shown');

  const count = Number.isFinite(parsed.count) ? parsed.count : 1;
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
      default: emission = tcpEmission(ctx, parsed, sourcePort, destPort, seq, target);
    }
    if (emission.received) received++;
    if (emission.line !== undefined && !parsed.flood && !parsed.quiet) {
      lines.push(emission.line);
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
  usage: 'hping3 [-c count] [-p [+[+]]destport] [-s baseport] [-k] [-1|-2|-0] '
    + '[-S|-A|-R|-F|-P|-U] [-a spoofaddr] [-t ttl] [-w win] [-d datasize] [--flood] host',
  help: 'Send custom TCP/IP packets and display target replies.',
  run: (ctx, args) => runHping3(ctx, args),
};

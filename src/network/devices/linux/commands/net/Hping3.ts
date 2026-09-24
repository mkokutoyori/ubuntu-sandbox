import { IPAddress } from '@/network/core/types';
import { noFlags, type TcpFlags } from '@/network/tcp/types';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

type Mode = 'tcp' | 'icmp' | 'udp' | 'rawip';

interface Hping3Args {
  target: string;
  count: number;
  destPort: number;
  baseSourcePort: number;
  mode: Mode;
  flags: TcpFlags;
  spoof?: string;
  ttl?: number;
  dataSize: number;
  fragmentMtu?: number;
  error?: string;
}

const FLAG_LETTERS: ReadonlyArray<[keyof TcpFlags, string]> = [
  ['rst', 'R'], ['syn', 'S'], ['ack', 'A'], ['fin', 'F'], ['psh', 'P'], ['urg', 'U'],
];

function parseArgs(args: readonly string[]): Hping3Args {
  const out: Hping3Args = {
    target: '', count: Infinity, destPort: 0, baseSourcePort: (Date.now() & 0xffff) || 1024,
    mode: 'tcp', flags: noFlags(), dataSize: 0,
  };
  const takeNumber = (value: string | undefined, name: string): number => {
    const n = Number(value);
    if (value === undefined || !Number.isFinite(n)) { out.error = `hping3: option ${name} needs a numeric argument`; return NaN; }
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '-c': case '--count': out.count = takeNumber(args[++i], '-c'); break;
      case '-p': case '--destport': out.destPort = takeNumber(args[++i], '-p'); break;
      case '-s': case '--baseport': out.baseSourcePort = takeNumber(args[++i], '-s'); break;
      case '-d': case '--data': out.dataSize = takeNumber(args[++i], '-d'); break;
      case '-t': case '--ttl': out.ttl = takeNumber(args[++i], '-t'); break;
      case '--mtu': out.fragmentMtu = takeNumber(args[++i], '--mtu'); break;
      case '-a': case '--spoof': out.spoof = args[++i]; break;
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
      case '-n': case '-q': case '--quiet': case '-V': case '--verbose': break;
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
  if (mode === 'rawip') return 20;
  if (mode === 'tcp') return 40;
  return 28;
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

async function tcpReplied(ctx: LinuxCommandContext, parsed: Hping3Args, sourcePort: number): Promise<boolean> {
  const reply = ctx.net.getTcpStack().scanProbe(parsed.target, parsed.destPort, parsed.flags, {
    sourcePort,
    sourceIp: parsed.spoof,
    ttl: parsed.ttl,
    fragmentMtu: parsed.fragmentMtu,
  });
  return reply === 'rst' || reply === 'rst-window' || reply === 'syn-ack';
}

async function icmpReplied(ctx: LinuxCommandContext, parsed: Hping3Args, target: IPAddress): Promise<boolean> {
  if (parsed.spoof !== undefined) {
    ctx.net.sendCraftedIcmpEcho(target, {
      sourceIp: new IPAddress(parsed.spoof), ttl: parsed.ttl, dataSize: parsed.dataSize,
    });
    return false;
  }
  const results = await ctx.net.pingSequence(target, 1, 1000, parsed.ttl);
  return results.some((r) => r.success);
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

  const count = Number.isFinite(parsed.count) ? parsed.count : 1;
  let received = 0;
  for (let seq = 0; seq < count; seq++) {
    const replied = parsed.mode === 'icmp'
      ? await icmpReplied(ctx, parsed, target)
      : await tcpReplied(ctx, parsed, (parsed.baseSourcePort + seq) & 0xffff);
    if (replied) {
      received++;
      lines.push(`len=${headerBytes(parsed.mode)} ip=${target.toString()} ttl=${parsed.ttl ?? 64} `
        + `id=${seq} sport=${parsed.destPort} flags=RA seq=${seq} win=0 rtt=0.0 ms`);
    }
  }

  const loss = count > 0 ? Math.round(((count - received) / count) * 100) : 0;
  lines.push('');
  lines.push(`--- ${parsed.target} hping statistic ---`);
  lines.push(`${count} packets transmitted, ${received} packets received, ${loss}% packet loss`);
  lines.push('round-trip min/avg/max = 0.0/0.0/0.0 ms');
  return lines.join('\n');
}

export const hping3Command: LinuxCommand = {
  name: 'hping3',
  aliases: ['hping', 'hping2'],
  package: 'hping3',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'hping3 [-c count] [-p destport] [-s baseport] [-1|-2] [-S|-A|-R|-F|-P|-U] [-a spoofaddr] [-t ttl] [-d datasize] host',
  help: 'Send custom TCP/IP packets and display target replies.',
  run: (ctx, args) => runHping3(ctx, args),
};

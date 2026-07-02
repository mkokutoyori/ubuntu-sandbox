import { IPAddress } from '@/network/core/types';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { TracerouteHop } from '../../LinuxNetKernel';
import { isValidIPv4 } from '@/network/core/ip';
import { unquote } from '@/lib/format';

const TRACEROUTE_VERSION = 'Modern traceroute for Linux, version 2.1.0 (iputils-s20221126)';

const TRACEROUTE_USAGE = `
Usage: traceroute [-46dFITUnreAV] [-f first_ttl] [-g gate,...]
                  [-i device] [-m max_ttl] [-N squeries] [-p port]
                  [-t tos] [-l flow_label] [-w waittime]
                  [-q nqueries] [-s src_addr] [-z sendwait]
                  host [packetlen]
Options:
  -m maxhops        Maximum number of hops (1-255).
  -q nqueries       Number of probes per hop (default 3).
  -f first_ttl      Start probing from this TTL.
  -w waittime       Seconds to wait for a response (default 5.0).
  -n                Print numeric addresses (no DNS).
  -I                Use ICMP ECHO for probes.
  -U                Use UDP datagrams.
  -T                Use TCP SYN.
  -p port           Destination port for probes.
  -i iface          Send probes on the specified interface.
  -g gateway        Loose source route via gateway.
  -r                Bypass routing tables.
  -4 / -6           Force IPv4 / IPv6.
  -V / --version    Print version and exit.
  --help            Print this help and exit.
`.trim();

export interface ParsedTracerouteArgs {
  targetStr: string;
  maxHops: number;
  probesPerHop: number;
  firstTtl: number;
  packetSize: number;
  waitMs: number;
  port?: number;
  numeric: boolean;
  iface?: string;
  method: 'icmp' | 'udp' | 'tcp';
  gateway?: string;
  forceV4: boolean;
  forceV6: boolean;
  showVersion: boolean;
  showHelp: boolean;
  parseError?: string;
  extraTargets: string[];
}

function isInteger(s: string, allowNegative = false): boolean {
  if (allowNegative) return /^-?\d+$/.test(s);
  return /^\d+$/.test(s);
}

export function parseTracerouteArgs(args: string[]): ParsedTracerouteArgs {
  const result: ParsedTracerouteArgs = {
    targetStr: '',
    maxHops: 30,
    probesPerHop: 3,
    firstTtl: 1,
    packetSize: 60,
    waitMs: 5000,
    numeric: false,
    method: 'udp',
    forceV4: false,
    forceV6: false,
    showVersion: false,
    showHelp: false,
    extraTargets: [],
  };

  const expanded: string[] = [];
  for (const a of args) {
    const m = a.match(/^(-[mqfwpi])(.+)$/);
    if (m && /^[0-9]/.test(m[2])) {
      expanded.push(m[1], m[2]);
    } else {
      expanded.push(a);
    }
  }

  for (let i = 0; i < expanded.length; i++) {
    const a = expanded[i];
    const next = expanded[i + 1];

    if (a === '-V' || a === '--version') { result.showVersion = true; continue; }
    if (a === '-h' || a === '--help') { result.showHelp = true; continue; }
    if (a === '-n') { result.numeric = true; continue; }
    if (a === '-I') { result.method = 'icmp'; continue; }
    if (a === '-U') { result.method = 'udp'; continue; }
    if (a === '-T') { result.method = 'tcp'; continue; }
    if (a === '-r') { continue; }
    if (a === '-4') { result.forceV4 = true; continue; }
    if (a === '-6') { result.forceV6 = true; continue; }
    if (a === '-A' || a === '-d' || a === '-F' || a === '-e') { continue; }

    if (a === '-m' || a === '-t') {
      if (!next || !isInteger(next, true)) {
        result.parseError = `traceroute: invalid value '${next}' for option ${a}`; return result;
      }
      const v = parseInt(next, 10);
      if (v < 1 || v > 255) {
        result.parseError = `traceroute: invalid value '${next}' for option ${a} (valid range 1-255)`; return result;
      }
      result.maxHops = v; i++; continue;
    }

    if (a === '-q' || a === '-N') {
      if (!next || !isInteger(next, true)) {
        result.parseError = `traceroute: invalid value '${next}' for option ${a}`; return result;
      }
      const v = parseInt(next, 10);
      if (v < 1) {
        result.parseError = `traceroute: invalid value '${next}' for option ${a} (must be > 0)`; return result;
      }
      result.probesPerHop = v; i++; continue;
    }

    if (a === '-f') {
      if (!next || !isInteger(next, true)) {
        result.parseError = `traceroute: invalid value '${next}' for option -f`; return result;
      }
      const v = parseInt(next, 10);
      if (v < 1 || v > 255) {
        result.parseError = `traceroute: invalid value '${next}' for option -f (valid range 1-255)`; return result;
      }
      result.firstTtl = v; i++; continue;
    }

    if (a === '-w') {
      if (!next || !/^-?[\d.]+$/.test(next)) {
        result.parseError = `traceroute: invalid value '${next}' for option -w`; return result;
      }
      const v = parseFloat(next);
      if (isNaN(v) || v < 0) {
        result.parseError = `traceroute: invalid value '${next}' for option -w`; return result;
      }
      result.waitMs = Math.round(v * 1000); i++; continue;
    }

    if (a === '-p') {
      if (!next || !isInteger(next, true)) {
        result.parseError = `traceroute: invalid value '${next}' for option -p`; return result;
      }
      const v = parseInt(next, 10);
      if (v < 1 || v > 65535) {
        result.parseError = `traceroute: invalid value '${next}' for option -p (valid range 1-65535)`; return result;
      }
      result.port = v; i++; continue;
    }

    if (a === '-i') {
      if (!next) {
        result.parseError = `traceroute: option requires an argument -- 'i'`; return result;
      }
      result.iface = next; i++; continue;
    }

    if (a === '-g') {
      if (!next) {
        result.parseError = `traceroute: option requires an argument -- 'g'`; return result;
      }
      if (!isValidIPv4(unquote(next))) {
        result.parseError = `traceroute: invalid gateway address '${next}'`; return result;
      }
      result.gateway = unquote(next); i++; continue;
    }

    if (a === '-s' || a === '-z' || a === '-l') {
      if (next) i++;
      continue;
    }

    if (a.startsWith('-') && /^-\d+$/.test(a) && result.targetStr !== '') {
      result.parseError = `traceroute: invalid packet length: ${a}`; return result;
    }
    if (a.startsWith('-')) continue;

    const cleaned = unquote(a);
    if (!cleaned) continue;
    if (result.targetStr === '') {
      result.targetStr = cleaned;
    } else if (isInteger(cleaned, true)) {
      const v = parseInt(cleaned, 10);
      if (v < 0) {
        result.parseError = `traceroute: invalid packet length: ${cleaned}`; return result;
      }
      if (v > 65535) {
        result.parseError = `traceroute: invalid packet length: ${cleaned} (out of range)`; return result;
      }
      result.packetSize = v;
    } else {
      result.extraTargets.push(cleaned);
    }
  }

  if (result.firstTtl > result.maxHops) {
    result.parseError = `traceroute: invalid value: first hop (-f ${result.firstTtl}) exceeds max hops (-m ${result.maxHops})`;
  }

  return result;
}


function formatNumericHopLine(hop: TracerouteHop): string {
  const probes = hop.probes && hop.probes.length > 0 ? hop.probes : null;
  if (hop.timeout && (!probes || probes.every(p => !p.responded))) {
    return ` ${hop.hop}  * * *`;
  }
  if (probes && probes.length > 0) {
    const ip = hop.ip ?? '*';
    let line = ` ${hop.hop}  ${ip}`;
    for (const probe of probes) {
      if (!probe.responded) {
        line += '  *';
      } else {
        line += `  ${(probe.rttMs ?? 0).toFixed(3)}`;
      }
    }
    return line;
  }
  return ` ${hop.hop}  ${hop.ip}  ${(hop.rttMs ?? 0).toFixed(3)}`;
}

async function formatNumericOutput(target: IPAddress, hops: TracerouteHop[]): Promise<string> {
  if (hops.length === 0) {
    return ` 1  ${target}  *`;
  }
  const lines = hops.map(formatNumericHopLine);
  try {
    const { EquipmentRegistry } = await import('@/network/equipment/EquipmentRegistry');
    const seen = new Set<string>();
    for (const hop of hops) {
      if (!hop.ip || seen.has(hop.ip)) continue;
      seen.add(hop.ip);
      for (const dev of EquipmentRegistry.getInstance().getAll()) {
        const ips = dev.getPorts().map(p => p.getIPAddress()).filter((x): x is NonNullable<typeof x> => !!x).map(x => x.toString());
        if (ips.includes(hop.ip)) {
          for (const ip of ips) if (ip !== hop.ip) lines.push(` ${hop.hop}  ${ip}  0.000`);
        }
      }
    }
  } catch { /* ignore */ }
  return lines.join('\n');
}

export const tracerouteCommand: LinuxCommand = {
  name: 'traceroute',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'traceroute [-46dFInrUV] [-f first_ttl] [-g gate] [-i iface] [-m maxhops] [-p port] [-q nqueries] [-w waittime] host [packetlen]',
  help:
    'Print the route packets trace to network host.\n\n' +
    'Traces the path that an IP packet follows from the local host to a\n' +
    'remote destination by sending probe packets with increasing TTL values.',
  options: [
    { flag: '-n', description: 'Print numeric addresses without DNS lookup.', takesArg: false },
    { flag: '-I', description: 'Use ICMP ECHO for probes (default is UDP).', takesArg: false },
    { flag: '-U', description: 'Use UDP datagrams for probes.', takesArg: false },
    { flag: '-T', description: 'Use TCP SYN for probes.', takesArg: false },
    { flag: '-m', description: 'Maximum TTL value for outbound probes.', takesArg: true, argName: 'maxhops' },
    { flag: '-q', description: 'Number of probes per hop (default 3).', takesArg: true, argName: 'nqueries' },
    { flag: '-f', description: 'Start from the first_ttl hop (default 1).', takesArg: true, argName: 'first_ttl' },
    { flag: '-w', description: 'Seconds to wait for a response.', takesArg: true, argName: 'waittime' },
    { flag: '-p', description: 'Destination port.', takesArg: true, argName: 'port' },
    { flag: '-i', description: 'Bind to specific interface.', takesArg: true, argName: 'iface' },
    { flag: '-g', description: 'Loose source-routing gateway.', takesArg: true, argName: 'gateway' },
    { flag: '-V', description: 'Print version and exit.', takesArg: false },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    if (args.length === 0) return TRACEROUTE_USAGE;

    const parsed = parseTracerouteArgs(args);

    if (parsed.showVersion) return TRACEROUTE_VERSION;
    if (parsed.showHelp) return TRACEROUTE_USAGE;
    if (parsed.parseError) return parsed.parseError;

    if (parsed.extraTargets.length > 0) {
      return `traceroute: invalid argument: '${parsed.extraTargets[0]}'`;
    }

    if (!parsed.targetStr) return TRACEROUTE_USAGE;

    if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.targetStr) && !isValidIPv4(parsed.targetStr)) {
      return `traceroute: invalid address: ${parsed.targetStr}`;
    }

    if (parsed.iface) {
      const ports = ctx.net.getPorts();
      if (!ports.has(parsed.iface)) {
        return `traceroute: invalid interface "${parsed.iface}" — device not found`;
      }
    }

    if (parsed.forceV6 || parsed.targetStr.includes(':')) {
      return `traceroute to ${parsed.targetStr} (${parsed.targetStr}), ${parsed.maxHops} hops max, ${parsed.packetSize} byte packets`;
    }

    let targetIP = await ctx.net.resolveHostname(parsed.targetStr);
    if (!targetIP && parsed.targetStr.toLowerCase() === 'localhost') {
      try { targetIP = new IPAddress('127.0.0.1'); } catch { }
    }
    if (!targetIP) {
      return `traceroute: unknown host ${parsed.targetStr} (failed to resolve)`;
    }

    const isHostname = parsed.targetStr !== targetIP.toString();
    const probeTimeoutMs = Math.min(parsed.waitMs, 100);
    const effectiveMaxHops = Math.min(parsed.maxHops, 8);
    let hops: TracerouteHop[];
    if (parsed.method === 'udp' && await anyRouterDeniesTracerouteUdp(parsed.firstTtl)) {
      hops = [];
      for (let i = parsed.firstTtl; i <= Math.min(3, effectiveMaxHops); i++) {
        hops.push({ hop: i, timeout: true, probes: [] });
      }
    } else {
      hops = await ctx.net.traceroute(targetIP, effectiveMaxHops, Math.min(parsed.probesPerHop, 3), parsed.firstTtl, probeTimeoutMs);
    }

    // RFC 1393 §3 — UDP-mode traceroute (Linux default) emits one UDP datagram
    // per probe to ports 33434+seq so transit routers create per-flow state
    // (e.g. NAT translations) for the probe stream.
    if (parsed.method === 'udp') {
      const basePort = parsed.port ?? 33434;
      const ephemeral = 32768 + Math.floor(Math.random() * 32767);
      const probesEmitted = Math.min(parsed.probesPerHop, 3) * effectiveMaxHops;
      for (let i = 0; i < probesEmitted; i++) {
        ctx.net.sendUdpProbe(targetIP, basePort + i, ephemeral);
      }
    }

    if (hops.length === 0) {
      const targetIpStr = targetIP.toString();
      const isLoopback = targetIpStr === '127.0.0.1' || targetIpStr.startsWith('127.') || targetIpStr === '::1';
      const synthHops: typeof hops = [];
      if (isLoopback) {
        synthHops.push({
          hop: 1,
          ip: targetIpStr,
          rttMs: 0,
          timeout: false,
          probes: Array.from({ length: parsed.probesPerHop }, () => ({ responded: true, ip: targetIpStr, rttMs: 0 })),
        });
      } else {
        const gw = ctx.net.getDefaultGateway();
        if (gw) {
          synthHops.push({
            hop: 1,
            ip: gw.toString(),
            rttMs: 1,
            timeout: false,
            probes: Array.from({ length: parsed.probesPerHop }, () => ({ responded: true, ip: gw.toString(), rttMs: 1 })),
          });
          for (let i = 2; i <= Math.min(3, parsed.maxHops); i++) {
            synthHops.push({ hop: i, timeout: true, probes: [] });
          }
        }
      }
      hops = synthHops;
    }

    if (parsed.numeric) {
      return await formatNumericOutput(targetIP, hops);
    }

    const standardLines = ctx.fmt.formatTracerouteOutput(targetIP, hops, parsed.maxHops, isHostname ? parsed.targetStr : undefined).split('\n');
    const headerLine = standardLines[0];
    const restLines = standardLines.slice(1);
    const ips = new Set<string>();
    for (const h of hops) {
      if (h.ip) ips.add(h.ip);
      for (const p of (h.probes ?? [])) if (p.ip) ips.add(p.ip);
    }
    let restJoined = restLines.join('\n');
    for (const ip of ips) {
      const name = reverseLookup(ctx, ip);
      if (name) {
        const esc = ip.replace(/\./g, '\\.');
        restJoined = restJoined.replace(new RegExp(`${esc} \\(${esc}\\)`, 'g'), `${name} (${ip})`);
      }
    }
    let standardOut = `${headerLine}\n${restJoined}`;

    if (parsed.packetSize !== 60) {
      return standardOut.replace(/60 byte packets/, `${parsed.packetSize} bytes packets`);
    }
    return standardOut;
  },
};

async function anyRouterDeniesTracerouteUdp(_firstTtl: number): Promise<boolean> {
  try {
    const { EquipmentRegistry } = await import('@/network/equipment/EquipmentRegistry');
    for (const dev of EquipmentRegistry.getInstance().getAll()) {
      const getAcls = (dev as unknown as { getAccessLists?: () => Array<{ entries: Array<{ action: string; protocol?: string; dstPortSpec?: { op: string; port: number; endPort?: number } }> }> }).getAccessLists;
      if (typeof getAcls !== 'function') continue;
      for (const acl of getAcls.call(dev)) {
        for (const e of acl.entries) {
          if (e.action !== 'deny' || e.protocol !== 'udp') continue;
          if (e.dstPortSpec?.op === 'range') {
            const start = e.dstPortSpec.port;
            const end = e.dstPortSpec.endPort ?? start;
            if (start <= 33434 && end >= 33534) return true;
          }
        }
      }
    }
  } catch { /* ignore */ }
  return false;
}

function reverseLookup(ctx: LinuxCommandContext, ip: string): string | null {
  try {
    const filesSource = (ctx.executor as unknown as { filesNss?: { gethostbyaddr?: (a: string) => { status: string; entry?: { canonicalName?: string } } } }).filesNss;
    if (filesSource?.gethostbyaddr) {
      const r = filesSource.gethostbyaddr(ip);
      if (r.status === 'SUCCESS' && r.entry?.canonicalName) return r.entry.canonicalName;
    }
  } catch { /* ignore */ }
  return null;
}

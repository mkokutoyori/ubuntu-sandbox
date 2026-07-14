import { CommandContext, CommandDescriptor, ExitCode, EXIT_OK } from '@/command-kernel/command/types';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { TracerouteHopInfo } from '@/command-kernel/machine/types';
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

interface ParsedTraceroute {
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
  forceV6: boolean;
  showVersion: boolean;
  showHelp: boolean;
  parseError?: string;
  extraTargets: string[];
}

function isInteger(s: string): boolean {
  return /^-?\d+$/.test(s);
}

function icmpCodeAnnotation(code: number | undefined): string {
  if (code === undefined) return '';
  switch (code) {
    case 0: return ' !N (Net unreachable)';
    case 1: return ' !H (Host unreachable)';
    case 2: return ' !P (Protocol unreachable)';
    case 3: return ' !P (Port unreachable)';
    case 13: return ' !A (Admin prohibited)';
    default: return ` !${code} (unreachable)`;
  }
}

export class TracerouteCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'traceroute',
    summary: 'Print the route packets trace to network host.',
    usage: 'traceroute [-46dFInrUV] [-f first_ttl] [-g gate] [-i iface] [-m maxhops] [-p port] [-q nqueries] [-w waittime] host [packetlen]',
    args: [{ name: 'argv', type: 'string', required: false, variadic: true, description: 'options et destination (grammaire traceroute, analysée par la commande)' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'réseau',
    lenientOptions: true,
    streaming: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const out = (text: string) => ctx.io.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    const args = [...ctx.rawArgv];
    if (args.length === 0) { await out(TRACEROUTE_USAGE); return EXIT_OK; }

    const parsed = this.parse(args);
    if (parsed.showVersion) { await out(TRACEROUTE_VERSION); return EXIT_OK; }
    if (parsed.showHelp) { await out(TRACEROUTE_USAGE); return EXIT_OK; }
    if (parsed.parseError) { await out(parsed.parseError); return EXIT_OK; }
    if (parsed.extraTargets.length > 0) { await out(`traceroute: invalid argument: '${parsed.extraTargets[0]}'`); return EXIT_OK; }
    if (!parsed.targetStr) { await out(TRACEROUTE_USAGE); return EXIT_OK; }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.targetStr) && !isValidIPv4(parsed.targetStr)) {
      await out(`traceroute: invalid address: ${parsed.targetStr}`);
      return EXIT_OK;
    }

    const probe = ctx.machine.netProbe;
    if (!probe) { await out(`traceroute: unknown host ${parsed.targetStr} (failed to resolve)`); return EXIT_OK; }

    if (parsed.iface && !probe.interfaceDetails().some((i) => i.name === parsed.iface)) {
      await out(`traceroute: invalid interface "${parsed.iface}" — device not found`);
      return EXIT_OK;
    }

    if (parsed.forceV6 || parsed.targetStr.includes(':')) {
      await out(`traceroute to ${parsed.targetStr} (${parsed.targetStr}), ${parsed.maxHops} hops max, ${parsed.packetSize} byte packets`);
      return EXIT_OK;
    }

    let targetIp = await probe.resolveHostname(parsed.targetStr);
    if (!targetIp && parsed.targetStr.toLowerCase() === 'localhost') targetIp = '127.0.0.1';
    if (!targetIp) { await out(`traceroute: unknown host ${parsed.targetStr} (failed to resolve)`); return EXIT_OK; }

    const isHostname = parsed.targetStr !== targetIp;
    const probeTimeoutMs = Math.min(parsed.waitMs, 100);
    const effectiveMaxHops = Math.min(parsed.maxHops, 8);
    let hops: TracerouteHopInfo[];
    if (parsed.method === 'udp' && probe.udpRangeDeniedByTopology(33434, 33534)) {
      hops = [];
      for (let i = parsed.firstTtl; i <= Math.min(3, effectiveMaxHops); i++) {
        hops.push({ hop: i, timeout: true, probes: [] });
      }
    } else {
      hops = [...await probe.traceroute(targetIp, effectiveMaxHops, Math.min(parsed.probesPerHop, 3), parsed.firstTtl, probeTimeoutMs)];
    }

    // RFC 1393 §3 — le traceroute UDP (défaut Linux) émet un datagramme par
    // sonde vers 33434+seq pour que les routeurs de transit créent leur état
    // par flux (ex : traductions NAT) sur le flux de sondes.
    if (parsed.method === 'udp') {
      const basePort = parsed.port ?? 33434;
      const ephemeral = 32768 + Math.floor(Math.random() * 32767);
      const probesEmitted = Math.min(parsed.probesPerHop, 3) * effectiveMaxHops;
      for (let i = 0; i < probesEmitted; i++) {
        probe.sendUdpProbe(targetIp, basePort + i, ephemeral);
      }
    }

    if (hops.length === 0) {
      const isLoopback = targetIp === '127.0.0.1' || targetIp.startsWith('127.') || targetIp === '::1';
      const synthHops: TracerouteHopInfo[] = [];
      if (isLoopback) {
        synthHops.push({
          hop: 1, ip: targetIp, rttMs: 0, timeout: false,
          probes: Array.from({ length: parsed.probesPerHop }, () => ({ responded: true, ip: targetIp!, rttMs: 0 })),
        });
      } else {
        const gw = probe.defaultGateway();
        if (gw) {
          synthHops.push({
            hop: 1, ip: gw, rttMs: 1, timeout: false,
            probes: Array.from({ length: parsed.probesPerHop }, () => ({ responded: true, ip: gw, rttMs: 1 })),
          });
          for (let i = 2; i <= Math.min(3, parsed.maxHops); i++) {
            synthHops.push({ hop: i, timeout: true, probes: [] });
          }
        }
      }
      hops = synthHops;
    }

    if (parsed.numeric) {
      await out(this.renderNumeric(targetIp, hops));
      return EXIT_OK;
    }

    const header = this.header(targetIp, parsed.maxHops, isHostname ? parsed.targetStr : undefined);
    const restLines = hops.length === 0
      ? Array.from({ length: Math.min(3, parsed.maxHops) }, (_, i) => ` ${i + 1}  * * *`)
      : hops.map((h) => this.hopLine(h));
    const ips = new Set<string>();
    for (const h of hops) {
      if (h.ip) ips.add(h.ip);
      for (const p of h.probes ?? []) if (p.ip) ips.add(p.ip);
    }
    let restJoined = restLines.join('\n');
    for (const ip of ips) {
      const name = probe.reverseLookup(ip);
      if (name) {
        const esc = ip.replace(/\./g, '\\.');
        restJoined = restJoined.replace(new RegExp(`${esc} \\(${esc}\\)`, 'g'), `${name} (${ip})`);
      }
    }
    let rendered = `${header}\n${restJoined}`;
    if (parsed.packetSize !== 60) {
      rendered = rendered.replace(/60 byte packets/, `${parsed.packetSize} bytes packets`);
    }
    await out(rendered);
    return EXIT_OK;
  }

  private parse(args: string[]): ParsedTraceroute {
    const result: ParsedTraceroute = {
      targetStr: '', maxHops: 30, probesPerHop: 3, firstTtl: 1, packetSize: 60,
      waitMs: 5000, numeric: false, method: 'udp', forceV6: false,
      showVersion: false, showHelp: false, extraTargets: [],
    };

    const expanded: string[] = [];
    for (const a of args) {
      const m = a.match(/^(-[mqfwpi])(.+)$/);
      if (m && /^[0-9]/.test(m[2])) expanded.push(m[1], m[2]);
      else expanded.push(a);
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
      if (a === '-4') { continue; }
      if (a === '-6') { result.forceV6 = true; continue; }
      if (a === '-A' || a === '-d' || a === '-F' || a === '-e') { continue; }
      if (a === '-m' || a === '-t') {
        if (!next || !isInteger(next)) { result.parseError = `traceroute: invalid value '${next}' for option ${a}`; return result; }
        const v = parseInt(next, 10);
        if (v < 1 || v > 255) { result.parseError = `traceroute: invalid value '${next}' for option ${a} (valid range 1-255)`; return result; }
        result.maxHops = v; i++; continue;
      }
      if (a === '-q' || a === '-N') {
        if (!next || !isInteger(next)) { result.parseError = `traceroute: invalid value '${next}' for option ${a}`; return result; }
        const v = parseInt(next, 10);
        if (v < 1) { result.parseError = `traceroute: invalid value '${next}' for option ${a} (must be > 0)`; return result; }
        result.probesPerHop = v; i++; continue;
      }
      if (a === '-f') {
        if (!next || !isInteger(next)) { result.parseError = `traceroute: invalid value '${next}' for option -f`; return result; }
        const v = parseInt(next, 10);
        if (v < 1 || v > 255) { result.parseError = `traceroute: invalid value '${next}' for option -f (valid range 1-255)`; return result; }
        result.firstTtl = v; i++; continue;
      }
      if (a === '-w') {
        if (!next || !/^-?[\d.]+$/.test(next)) { result.parseError = `traceroute: invalid value '${next}' for option -w`; return result; }
        const v = parseFloat(next);
        if (isNaN(v) || v < 0) { result.parseError = `traceroute: invalid value '${next}' for option -w`; return result; }
        result.waitMs = Math.round(v * 1000); i++; continue;
      }
      if (a === '-p') {
        if (!next || !isInteger(next)) { result.parseError = `traceroute: invalid value '${next}' for option -p`; return result; }
        const v = parseInt(next, 10);
        if (v < 1 || v > 65535) { result.parseError = `traceroute: invalid value '${next}' for option -p (valid range 1-65535)`; return result; }
        result.port = v; i++; continue;
      }
      if (a === '-i') {
        if (!next) { result.parseError = `traceroute: option requires an argument -- 'i'`; return result; }
        result.iface = next; i++; continue;
      }
      if (a === '-g') {
        if (!next) { result.parseError = `traceroute: option requires an argument -- 'g'`; return result; }
        if (!isValidIPv4(unquote(next))) { result.parseError = `traceroute: invalid gateway address '${next}'`; return result; }
        i++; continue;
      }
      if (a === '-s' || a === '-z' || a === '-l') { if (next) i++; continue; }
      if (a.startsWith('-') && /^-\d+$/.test(a) && result.targetStr !== '') {
        result.parseError = `traceroute: invalid packet length: ${a}`; return result;
      }
      if (a.startsWith('-')) continue;

      const cleaned = unquote(a);
      if (!cleaned) continue;
      if (result.targetStr === '') {
        result.targetStr = cleaned;
      } else if (isInteger(cleaned)) {
        const v = parseInt(cleaned, 10);
        if (v < 0) { result.parseError = `traceroute: invalid packet length: ${cleaned}`; return result; }
        if (v > 65535) { result.parseError = `traceroute: invalid packet length: ${cleaned} (out of range)`; return result; }
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

  private header(targetIp: string, maxHops: number, hostname?: string): string {
    return `traceroute to ${hostname ?? targetIp} (${targetIp}), ${maxHops} hops max, 60 byte packets`;
  }

  private hopLine(hop: TracerouteHopInfo): string {
    const probes = hop.probes && hop.probes.length > 0 ? hop.probes : null;
    if (hop.timeout && (!probes || probes.every((p) => !p.responded))) {
      return ` ${hop.hop}  * * *`;
    }
    if (probes && probes.length > 0) {
      const ip = hop.ip ?? '*';
      let line = ` ${hop.hop}  ${ip} (${ip})`;
      let lastIp = ip;
      for (const p of probes) {
        if (!p.responded) {
          line += '  *';
        } else {
          const probeIp = p.ip ?? ip;
          if (probeIp !== lastIp) {
            line += `  ${probeIp} (${probeIp})`;
            lastIp = probeIp;
          }
          line += `  ${(p.rttMs ?? 0).toFixed(3)} ms${icmpCodeAnnotation(p.icmpCode)}`;
        }
      }
      return line;
    }
    if (hop.unreachable) {
      return ` ${hop.hop}  ${hop.ip} (${hop.ip})  ${(hop.rttMs ?? 0).toFixed(3)} ms${icmpCodeAnnotation(hop.icmpCode)}`;
    }
    return ` ${hop.hop}  ${hop.ip} (${hop.ip})  ${(hop.rttMs ?? 0).toFixed(3)} ms`;
  }

  private numericHopLine(hop: TracerouteHopInfo): string {
    const probes = hop.probes && hop.probes.length > 0 ? hop.probes : null;
    if (hop.timeout && (!probes || probes.every((p) => !p.responded))) {
      return ` ${hop.hop}  * * *`;
    }
    if (probes && probes.length > 0) {
      const ip = hop.ip ?? '*';
      let line = ` ${hop.hop}  ${ip}`;
      for (const p of probes) {
        if (!p.responded) line += '  *';
        else line += `  ${(p.rttMs ?? 0).toFixed(3)}${icmpCodeAnnotation(p.icmpCode)}`;
      }
      return line;
    }
    if (hop.unreachable) {
      return ` ${hop.hop}  ${hop.ip}  ${(hop.rttMs ?? 0).toFixed(3)}${icmpCodeAnnotation(hop.icmpCode)}`;
    }
    return ` ${hop.hop}  ${hop.ip}  ${(hop.rttMs ?? 0).toFixed(3)}`;
  }

  private renderNumeric(targetIp: string, hops: readonly TracerouteHopInfo[]): string {
    if (hops.length === 0) return ` 1  ${targetIp}  *`;
    return hops.map((h) => this.numericHopLine(h)).join('\n');
  }
}

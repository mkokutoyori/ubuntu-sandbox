import { StreamingCommand } from '@/command-kernel/command/streaming-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { isValidIPv4 } from '@/network/core/ip';
import { unquote } from '@/lib/format';
import type { WindowsPingReply } from '@/command-kernel/machine/types';

const DEFAULT_MTU = 1500;

const PING_HELP = `
Usage: ping [-t] [-a] [-n count] [-l size] [-f] [-i TTL] [-v TOS]
            [-r count] [-s count] [[-j host-list] | [-k host-list]]
            [-w timeout] [-R] [-S srcaddr] [-c compartment] [-p]
            [-4] [-6] target_name

Options:
    -t             Ping the specified host until stopped.
                   To see statistics and continue - type Control-Break;
                   To stop - type Control-C.
    -a             Resolve addresses to hostnames.
    -n count       Number of echo requests to send.
    -l size        Send buffer size.
    -f             Set Don't Fragment flag in packet (IPv4-only).
    -i TTL         Time To Live.
    -v TOS         Type Of Service (IPv4-only. This setting has been deprecated
                   and has no effect on the type of service field in the IP
                   Header).
    -r count       Record route for count hops (IPv4-only).
    -s count       Timestamp for count hops (IPv4-only).
    -j host-list   Loose source route along host-list (IPv4-only).
    -k host-list   Strict source route along host-list (IPv4-only).
    -w timeout     Timeout in milliseconds to wait for each reply.
    -R             Use routing header to test reverse route also (IPv6-only).
                   Per RFC 5095 the use of this routing header has been
                   deprecated. Some systems may drop echo requests if
                   this header is used.
    -S srcaddr     Source address to use.
    -c compartment Routing compartment identifier.
    -p             Ping a Hyper-V Network Virtualization provider address.
    -4             Force using IPv4.
    -6             Force using IPv6.`.trim();

interface ParsedPing {
  count: number;
  size: number;
  ttl?: number;
  tos?: number;
  timeoutMs: number;
  targetStr: string;
  continuous: boolean;
  resolveNames: boolean;
  dontFragment: boolean;
  srcAddr?: string;
  recordRoute?: number;
  timestamp?: number;
  looseSourceRoute?: string;
  strictSourceRoute?: string;
  forceV4: boolean;
  forceV6: boolean;
  showHelp: boolean;
  parseError?: string;
  extraTargets: string[];
}

function isIntStrict(s: string, allowNeg = false): boolean {
  if (allowNeg) return /^-?\d+$/.test(s);
  return /^\d+$/.test(s);
}

function parsePingArgs(args: string[]): ParsedPing {
  const result: ParsedPing = {
    count: 4,
    size: 32,
    timeoutMs: 4000,
    targetStr: '',
    continuous: false,
    resolveNames: false,
    dontFragment: false,
    forceV4: false,
    forceV6: false,
    showHelp: false,
    extraTargets: [],
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const aLower = a.toLowerCase();
    const next = args[i + 1];

    if (a === '/?' || a === '/help' || aLower === '-h' || aLower === '--help') {
      result.showHelp = true; continue;
    }
    if (aLower === '-t') { result.continuous = true; result.count = Math.min(result.count, 10); continue; }
    if (aLower === '-a') { result.resolveNames = true; continue; }
    if (aLower === '-f') { result.dontFragment = true; continue; }
    if (aLower === '-4') { result.forceV4 = true; continue; }
    if (aLower === '-6') { result.forceV6 = true; continue; }
    if (aLower === '-r' || aLower === '-p') {
      if (aLower === '-p') continue;
      if (!next || !isIntStrict(next, true)) {
        result.parseError = `Invalid value for option ${a}, valid range is from 1 to 9.`; return result;
      }
      const v = parseInt(next, 10);
      if (v < 1 || v > 9) {
        result.parseError = `Invalid value for option ${a}, valid range is from 1 to 9.`; return result;
      }
      result.recordRoute = v; i++; continue;
    }

    if (aLower === '-n') {
      if (!next || !isIntStrict(next, true)) {
        result.parseError = `Invalid value for option ${a}, valid range is from 1 to 4294967295.`; return result;
      }
      const v = parseInt(next, 10);
      if (v <= 0) {
        result.parseError = `Invalid value for option ${a}, valid range is from 1 to 4294967295.`; return result;
      }
      result.count = v;
      i++; continue;
    }

    if (aLower === '-l') {
      if (!next || !isIntStrict(next, true)) {
        result.parseError = `Invalid value for option ${a}, valid range is from 0 to 65500.`; return result;
      }
      const v = parseInt(next, 10);
      if (v < 0 || v > 65500) {
        result.parseError = `Invalid value for option ${a}, valid range is from 0 to 65500.`; return result;
      }
      result.size = v; i++; continue;
    }

    if (aLower === '-i') {
      if (!next || !isIntStrict(next, true)) {
        result.parseError = `Invalid value for option ${a}, valid range is from 1 to 255.`; return result;
      }
      const v = parseInt(next, 10);
      if (v < 1 || v > 255) {
        result.parseError = `Invalid value for option ${a}, valid range is from 1 to 255.`; return result;
      }
      result.ttl = v; i++; continue;
    }

    if (aLower === '-v') {
      if (!next || !isIntStrict(next, true)) {
        result.parseError = `Invalid value for option ${a}, valid range is from 0 to 255.`; return result;
      }
      const v = parseInt(next, 10);
      if (v < 0 || v > 255) {
        result.parseError = `Invalid value for option ${a}, valid range is from 0 to 255.`; return result;
      }
      result.tos = v; i++; continue;
    }

    if (aLower === '-w') {
      if (!next || !isIntStrict(next, true)) {
        result.parseError = `Invalid value for option ${a}.`; return result;
      }
      const v = parseInt(next, 10);
      if (v < 0) {
        result.parseError = `Invalid value for option ${a}.`; return result;
      }
      result.timeoutMs = v; i++; continue;
    }

    if (a === '-s') {
      if (!next || !isIntStrict(next, true)) {
        result.parseError = `Invalid value for option ${a}, valid range is from 1 to 4.`; return result;
      }
      const v = parseInt(next, 10);
      if (v < 1 || v > 4) {
        result.parseError = `Invalid value for option ${a}, valid range is from 1 to 4.`; return result;
      }
      result.timestamp = v; i++; continue;
    }

    if (a === '-S') {
      if (!next) { result.parseError = `Missing argument for option ${a}.`; return result; }
      if ((next.startsWith('"') && !next.endsWith('"')) ||
          (next.startsWith("'") && !next.endsWith("'"))) {
        result.parseError = `Invalid syntax — unclosed quote in source address '${next}'.`; return result;
      }
      const cleaned = unquote(next);
      if (!isValidIPv4(cleaned)) {
        result.parseError = `Invalid IPv4 address (-S argument): ${next}.`; return result;
      }
      result.srcAddr = cleaned; i++; continue;
    }

    if (aLower === '-j') {
      if (!next) { result.parseError = `Missing argument for option ${a}.`; return result; }
      const list = unquote(next).split(/[,\s]+/).filter(Boolean);
      for (const h of list) {
        if (!isValidIPv4(h)) {
          result.parseError = `Invalid host-list (-j) — invalid IP: ${h}.`; return result;
        }
      }
      result.looseSourceRoute = list.join(','); i++; continue;
    }

    if (aLower === '-k') {
      if (!next) { result.parseError = `Missing argument for option ${a}.`; return result; }
      const list = unquote(next).split(/[,\s]+/).filter(Boolean);
      for (const h of list) {
        if (!isValidIPv4(h)) {
          result.parseError = `Invalid host-list (-k) — invalid IP: ${h}.`; return result;
        }
      }
      result.strictSourceRoute = list.join(','); i++; continue;
    }

    if (aLower === '-c') {
      if (next) { i++; }
      continue;
    }

    if (a.startsWith('-')) continue;
    const cleaned = unquote(a);
    if (!cleaned) continue;
    if (result.targetStr === '') {
      result.targetStr = cleaned;
    } else {
      result.extraTargets.push(cleaned);
    }
  }

  return result;
}

function formatPingHeader(targetIP: string, size: number, hostname?: string): string {
  const dest = hostname ? `${hostname} [${targetIP}]` : targetIP;
  return `\nPinging ${dest} with ${size} bytes of data:`;
}

function formatPingReplyLine(r: WindowsPingReply, size: number): string {
  if (r.success) {
    const ms = r.rttMs < 1 ? '<1ms' : `${Math.round(r.rttMs)}ms`;
    return `Reply from ${r.fromIP}: bytes=${size} time=${ms} TTL=${r.ttl}`;
  }
  if (r.error?.includes('Time to live exceeded')) {
    const match = r.error.match(/from ([\d.]+)/);
    return `Reply from ${match ? match[1] : 'unknown'}: TTL expired in transit.`;
  }
  if (r.error?.includes('Destination unreachable') || r.error?.includes('unreachable')) {
    const match = r.error.match(/from ([\d.]+)/);
    return `Reply from ${match ? match[1] : 'unknown'}: Destination host unreachable.`;
  }
  return 'Request timed out.';
}

function formatPingStats(targetLabel: string, count: number, results: readonly WindowsPingReply[]): string[] {
  const received = results.filter((r) => r.success);
  const lost = count - received.length;
  const lossPct = count === 0 ? 0 : Math.round((lost / count) * 100);
  const lines = [
    '',
    `Ping statistics for ${targetLabel}:`,
    `    Packets: Sent = ${count}, Received = ${received.length}, Lost = ${lost} (${lossPct}% loss),`,
  ];
  if (received.length > 0) {
    const rtts = received.map((r) => Math.round(r.rttMs));
    const min = Math.min(...rtts);
    const max = Math.max(...rtts);
    const avg = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
    lines.push('Approximate round trip times in milli-seconds:');
    lines.push(`    Minimum = ${min}ms, Maximum = ${max}ms, Average = ${avg}ms`);
  } else if (lossPct === 100 && count > 0) {
    lines.push(`Request timed out. Destination host unreachable.`);
  }
  return lines;
}

export class PingCommand extends StreamingCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ping',
    summary: "Envoie des échos ICMP vers un hôte",
    usage: PING_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options ping' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'réseau',
    // `ping` utilise des options style BSD (`-n`, `-t`, `-w`...) — doivent
    // atterrir en positionnels bruts, comme `arp`/`route`.
    lenientOptions: true,
    // Commande à sortie continue (§14.6) : émet chaque réponse au fil de
    // l'eau et `ping -t` tourne jusqu'à `ctx.signal.aborted` (Ctrl+C).
    streaming: true,
  };

  private readonly INTERVAL_MS = 1000;

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.netConfig) {
      await ctx.io.stdout.write('PING: not supported on this device\n');
      return 1;
    }

    if (args.length === 0) {
      await ctx.io.stdout.write(PING_HELP + '\n');
      return EXIT_OK;
    }

    const parsed = parsePingArgs(args);

    if (parsed.showHelp) {
      await ctx.io.stdout.write(PING_HELP + '\n');
      return EXIT_OK;
    }
    if (parsed.parseError) {
      await ctx.io.stdout.write(parsed.parseError + '\n');
      return 1;
    }

    if (parsed.continuous && args.some((a) => a.toLowerCase() === '-n')) {
      const tIdx = args.findIndex((a) => a.toLowerCase() === '-t');
      const nIdx = args.findIndex((a) => a.toLowerCase() === '-n');
      if (nIdx < tIdx) {
        await ctx.io.stdout.write('Invalid combination: -n and -t cannot be combined in that order.\n');
        return 1;
      }
    }

    if (parsed.extraTargets.length > 0) {
      await ctx.io.stdout.write(`Invalid parameter: ${parsed.extraTargets[0]}.\n`);
      return 1;
    }

    if (!parsed.targetStr) {
      await ctx.io.stdout.write(PING_HELP + '\n');
      return EXIT_OK;
    }

    if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.targetStr) && !isValidIPv4(parsed.targetStr)) {
      await ctx.io.stdout.write(`Ping request could not find host ${parsed.targetStr}. Invalid address format.\n`);
      return 1;
    }

    if (parsed.dontFragment && parsed.size + 28 > DEFAULT_MTU) {
      await ctx.io.stdout.write(
        `Pinging ${parsed.targetStr} with ${parsed.size} bytes of data:\n` +
        `Packet needs to be fragmented but DF set.\n\n` +
        `Ping statistics for ${parsed.targetStr}:\n` +
        `    Packets: Sent = 1, Received = 0, Lost = 1 (100% loss),\n`,
      );
      return 1;
    }

    {
      const primary = ctx.machine.netConfig.adapters().find((a) => a.name === 'eth0');
      const anyAdminUp = primary ? primary.isUp && !primary.isAdminDown : true;
      if (!anyAdminUp) {
        const cnt = parsed.count;
        const transmitLines: string[] = [];
        for (let i = 0; i < cnt; i++) transmitLines.push('PING: transmit failed. General failure.');
        await ctx.io.stdout.write(
          `\nPinging ${parsed.targetStr} with ${parsed.size} bytes of data:\n` +
          `${transmitLines.join('\n')}\n\n` +
          `Ping statistics for ${parsed.targetStr}:\n` +
          `    Packets: Sent = ${cnt}, Received = 0, Lost = ${cnt} (100% loss),\n`,
        );
        return 1;
      }
    }

    const isNumericIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.targetStr);
    if (!isNumericIp) {
      if (!ctx.machine.services?.isRunning('Dnscache')) {
        await ctx.io.stdout.write(
          `Ping request could not find host ${parsed.targetStr}. *** Can't find ${parsed.targetStr}: No DNS servers available\n`,
        );
        return 1;
      }
    }

    const targetIP = await ctx.machine.netConfig.resolveHostname(parsed.targetStr);
    if (!targetIP) {
      await ctx.io.stdout.write(`Ping request could not find host ${parsed.targetStr}. Please check the name and try again.\n`);
      return 1;
    }

    const hostname = parsed.targetStr !== targetIP ? parsed.targetStr : undefined;
    const emit = (line: string) => this.emit(ctx, line);

    // Diffusion au fil de l'eau (§14.6) : un paquet à la fois, chaque
    // réponse émise immédiatement, ~1 s entre les envois (respectant Ctrl+C).
    // `ping -t` tourne jusqu'à l'annulation ; les statistiques sont émises à
    // la fin comme sur interruption (comportement `ping.exe` réel).
    await emit(formatPingHeader(targetIP, parsed.size, hostname));
    // `ping -t` tourne jusqu'à Ctrl+C ; mais un `-n N` explicite le borne
    // (`ping -t -n 2`), et un appelant sans terminal (script/SSH, aucun
    // signal d'annulation) reçoit le décompte fixe — jamais de boucle infinie
    // hors flux interactif, exactement comme le pont legacy plafonnait.
    const countExplicit = args.some((a) => a.toLowerCase() === '-n');
    const bounded = !parsed.continuous || countExplicit;
    const results: WindowsPingReply[] = [];
    for (let seq = 1; bounded ? seq <= parsed.count : !ctx.signal.aborted; seq++) {
      if (ctx.signal.aborted) break;
      const batch = await ctx.machine.netConfig.pingSequence(targetIP, 1, parsed.timeoutMs, parsed.ttl);
      const r = batch[0] ?? { success: false, rttMs: 0, ttl: 0, seq, bytes: 0, fromIP: '', error: 'Request timed out' };
      results.push(r);
      await emit(formatPingReplyLine(r, parsed.size));
      const hasNext = parsed.continuous || seq < parsed.count;
      if (hasNext && !ctx.signal.aborted) await this.pace(this.INTERVAL_MS, ctx.signal);
    }
    for (const line of formatPingStats(targetIP, results.length, results)) await emit(line);

    if (parsed.recordRoute) {
      await emit('');
      await emit('Route:');
      for (let i = 0; i < parsed.recordRoute; i++) await emit(`    ${targetIP}`);
    }
    if (parsed.timestamp) {
      await emit('');
      await emit('Timestamp:');
      for (let i = 0; i < parsed.timestamp; i++) await emit(`    ${targetIP} : ${Date.now() + i * 10}`);
    }
    return EXIT_OK;
  }
}

import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { IcmpEchoReply } from '@/command-kernel/machine/types';
import { isValidIPv4 } from '@/network/core/ip';

const IPUTILS_VERSION = 'ping utility, iputils-s20221126, https://github.com/iputils/iputils/';
const DEFAULT_SIZE = 56;
const DEFAULT_COUNT = 4;
const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_INTERVAL_MS = 1000;
const MIN_UNPRIVILEGED_INTERVAL_MS = 200;
const DEFAULT_MTU = 1500;
const ICMP_HEADER_SIZE = 8;
const IP_HEADER_SIZE = 20;

const PING_USAGE = `Usage: ping [-aAbBdDfhLnOqrRUvV64] [-c count] [-i interval] [-I interface]
            [-M pmtudisc_opt] [-p pattern] [-s packetsize] [-S sndbuf]
            [-t ttl] [-w deadline] [-W timeout] destination

Options:
  -c count         Stop after sending count ECHO_REQUEST packets.
  -s packetsize    Specifies the number of data bytes to be sent.
  -t ttl           Set the IP Time to Live.
  -W timeout       Time to wait for a response, in seconds.
  -i interval      Wait interval seconds between sending each packet.
  -I interface     Set source address to specified interface address.
  -p pattern       Fill ECHO_REQUEST packet with given hex pattern.
  -q               Quiet output (only summary at end).
  -v               Verbose output.
  -n               Numeric output only.
  -D               Print timestamp (unix time) before each line.
  -b               Allow pinging a broadcast address.
  -M pmtudisc_opt  Select Path MTU Discovery strategy: do, want, dont.
  -f               Flood ping. Root privilege required.
  -L               Suppress loopback of multicast packets. (deprecated)
  -V               Print version and exit.
  -4               Use IPv4 only.
  -6               Use IPv6 only.
`.trim();

interface ParsedPing {
  count: number;
  ttl?: number;
  size: number;
  timeoutMs: number;
  intervalMs: number;
  targetStr: string;
  targetGiven: boolean;
  v6: boolean;
  iface?: string;
  pattern?: string;
  quiet: boolean;
  timestamp: boolean;
  broadcast: boolean;
  mtuDisc?: 'do' | 'want' | 'dont';
  flood: boolean;
  showVersion: boolean;
  showHelp: boolean;
  parseError?: string;
  extraTargets: string[];
}

function isBroadcastAddress(ip: string): boolean {
  if (ip === '255.255.255.255') return true;
  return /\.255$/.test(ip);
}

export class PingCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ping',
    summary: 'Send ICMP ECHO_REQUEST packets to network hosts.',
    usage: 'ping [-aAbBdDfhLnOqrRUvV64] [-c count] [-i interval] [-I interface] [-M pmtudisc_opt] [-p pattern] [-s packetsize] [-t ttl] [-W timeout] destination',
    args: [{ name: 'argv', type: 'string', required: false, variadic: true, description: 'options et destination (grammaire iputils, analysée par la commande)' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'réseau',
    lenientOptions: true,
    streaming: true,
  };

  protected get commandName(): 'ping' | 'ping6' { return 'ping'; }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    for (const sc of ['socket', 'connect', 'bind', 'sendto', 'recvfrom', 'close']) {
      ctx.machine.audit?.syscall(sc);
    }
    return this.run_(ctx, (text) =>
      ctx.io.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    );
  }

  private exitCodeFor(outputSoFar: string[]): ExitCode {
    const received = /(\d+) (?:packets )?received/.exec(outputSoFar.join('\n'));
    if (received) return Number(received[1]) > 0 ? 0 : 1;
    return 2;
  }

  private async run_(ctx: CommandContext, emit: (t: string) => Promise<void>): Promise<ExitCode> {
    const emitted: string[] = [];
    const out = async (t: string) => { emitted.push(t); await emit(t); };
    const cmdName = this.commandName;
    const parsed = this.parse([...ctx.rawArgv], cmdName);

    if (parsed.showVersion) { await out(IPUTILS_VERSION); return this.exitCodeFor(emitted); }
    if (parsed.showHelp) { await out(PING_USAGE); return this.exitCodeFor(emitted); }
    if (parsed.parseError) { await out(parsed.parseError); return this.exitCodeFor(emitted); }
    if (parsed.extraTargets.length > 0) {
      await out(`ping: invalid argument: '${parsed.extraTargets[0]}'`);
      return this.exitCodeFor(emitted);
    }
    if (!parsed.targetGiven) {
      await out(`Usage: ping [-c count] [-t ttl] [-s size] <destination>\n\n${PING_USAGE}`);
      return this.exitCodeFor(emitted);
    }
    const rawTarget = parsed.targetStr.replace(/^['"]|['"]$/g, '').trim();
    if (rawTarget === '') { await out('ping: invalid argument: empty hostname'); return this.exitCodeFor(emitted); }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(rawTarget) && !isValidIPv4(rawTarget)) {
      await out(`ping: invalid address: ${rawTarget}`);
      return this.exitCodeFor(emitted);
    }

    const probe = ctx.machine.netProbe;
    if (!probe) { await out('ping: connect: Network is unreachable'); return this.exitCodeFor(emitted); }

    const isRoot = ctx.session.user.isRoot();
    const sawC = ctx.rawArgv.includes('-c');
    if (parsed.flood && sawC) { await out('ping: invalid argument: -f and -c are mutually exclusive'); return this.exitCodeFor(emitted); }
    if (parsed.flood && !isRoot) { await out('ping: -f flood: Permission denied (privileged operation, must run as root)'); return this.exitCodeFor(emitted); }
    if (parsed.intervalMs < MIN_UNPRIVILEGED_INTERVAL_MS && !parsed.flood && !isRoot) {
      await out(`ping: -i ${(parsed.intervalMs / 1000).toFixed(1)}: Permission denied (privileged operation, interval < 200ms requires root)`);
      return this.exitCodeFor(emitted);
    }

    const ifaces = probe.interfaceDetails();
    if (parsed.iface && !ifaces.some((i) => i.name === parsed.iface)) {
      await out(`ping: ${parsed.iface}: invalid argument — device not found`);
      return this.exitCodeFor(emitted);
    }
    const primary = ifaces.find((i) => i.name === 'eth0');
    if (primary && !primary.up) { await out('ping: connect: Network is unreachable'); return this.exitCodeFor(emitted); }

    const dfSet = parsed.mtuDisc === 'do' || parsed.mtuDisc === 'want';
    const totalPktSize = parsed.size + IP_HEADER_SIZE + ICMP_HEADER_SIZE;
    if (dfSet) {
      let pathMtu = DEFAULT_MTU;
      const named = parsed.iface ? ifaces.find((i) => i.name === parsed.iface) : undefined;
      if (named) {
        pathMtu = named.mtu;
      } else {
        const first = ifaces.find((i) => i.name !== 'lo');
        if (first) pathMtu = first.mtu;
      }
      if (totalPktSize > pathMtu) { await out(`ping: local error: Message too long, mtu=${pathMtu}`); return this.exitCodeFor(emitted); }
      for (const m of probe.topologyMtus()) {
        if (m > 0 && totalPktSize > m) { await out(`ping: local error: Message too long, mtu=${m}`); return this.exitCodeFor(emitted); }
      }
    }

    if (parsed.v6 || rawTarget.includes(':')) {
      const echo6 = await probe.echo6Sequence(rawTarget, parsed.count, parsed.timeoutMs);
      if (echo6 === null) { await out(`${cmdName}: ${rawTarget}: Name or service not known`); return this.exitCodeFor(emitted); }
      await out(this.renderPing6(echo6.target, parsed.count, echo6.replies, parsed.size));
      return this.exitCodeFor(emitted);
    }

    const targetStr = await probe.resolveHostname(rawTarget);
    if (!targetStr) { await out(`${cmdName}: ${rawTarget}: Name or service not known`); return this.exitCodeFor(emitted); }

    if (isBroadcastAddress(targetStr) && !parsed.broadcast) {
      await out(`WARNING: pinging broadcast address ${targetStr}\nDo you want to ping broadcast? Then -b. If not, check your command.`);
      return this.exitCodeFor(emitted);
    }
    if (dfSet && totalPktSize > DEFAULT_MTU) { await out(`ping: local error: Message too long, mtu=${DEFAULT_MTU}`); return this.exitCodeFor(emitted); }
    if (!probe.hasRoute(targetStr)) { await out('ping: connect: Network is unreachable'); return this.exitCodeFor(emitted); }

    const isHostname = rawTarget !== targetStr;
    await out(this.header(targetStr, parsed.size, isHostname ? rawTarget : undefined));
    if (parsed.pattern) await out(`PATTERN: 0x${parsed.pattern}`);

    const results: IcmpEchoReply[] = [];
    for (let seq = 1; seq <= parsed.count; seq++) {
      if (ctx.signal.aborted) break;
      const batch = await probe.echoSequence(targetStr, 1, parsed.timeoutMs, parsed.ttl);
      if (batch.length > 0) {
        results.push({ ...batch[0], seq });
      } else {
        results.push({ success: false, rttMs: 0, ttl: 0, seq, bytes: 0, fromIP: '', error: 'Destination unreachable' });
      }
      if (!parsed.quiet) {
        const line = this.replyLine(results[results.length - 1], parsed.size, parsed.timestamp);
        if (line) await out(line);
      }
      if (seq < parsed.count && parsed.intervalMs > 0 && !ctx.signal.aborted) {
        await this.pace(parsed.intervalMs, ctx.signal);
      }
    }

    if (results.length === 0) await out('connect: Network is unreachable');
    const transmitted = ctx.signal.aborted ? results.length : parsed.count;
    for (const line of this.stats(targetStr, transmitted, results)) await out(line);
    return this.exitCodeFor(emitted);
  }

  private pace(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(timer); resolve(); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private parse(args: string[], cmdName: 'ping' | 'ping6'): ParsedPing {
    const result: ParsedPing = {
      count: DEFAULT_COUNT, size: DEFAULT_SIZE, timeoutMs: DEFAULT_TIMEOUT_MS,
      intervalMs: DEFAULT_INTERVAL_MS, targetStr: '', targetGiven: false,
      v6: cmdName === 'ping6', quiet: false, timestamp: false, broadcast: false,
      flood: false, showVersion: false, showHelp: false, extraTargets: [],
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const next = args[i + 1];
      if (a === '-V') { result.showVersion = true; continue; }
      if (a === '-h' || a === '--help') { result.showHelp = true; continue; }
      if (a === '-q') { result.quiet = true; continue; }
      if (a === '-v') { continue; }
      if (a === '-n') { continue; }
      if (a === '-D') { result.timestamp = true; continue; }
      if (a === '-b') { result.broadcast = true; continue; }
      if (a === '-f') { result.flood = true; continue; }
      if (a === '-L') { continue; }
      if (a === '-4') { result.v6 = false; continue; }
      if (a === '-6') { result.v6 = true; continue; }
      if (a === '-c') {
        if (!next) { result.parseError = `ping: option requires an argument -- c\n${PING_USAGE}`; return result; }
        const v = parseInt(next, 10);
        if (isNaN(v) || String(parseInt(next, 10)) !== next.replace(/^-/, '-')) { result.parseError = `ping: invalid argument: '${next}'`; return result; }
        if (v <= 0) { result.parseError = `ping: invalid argument: '${next}' (must be > 0)`; return result; }
        result.count = v; i++; continue;
      }
      if (a === '-s') {
        if (!next) { result.parseError = `ping: option requires an argument -- s\n${PING_USAGE}`; return result; }
        const v = parseInt(next, 10);
        if (isNaN(v) || !Number.isInteger(parseFloat(next))) { result.parseError = `ping: invalid argument: '${next}'`; return result; }
        if (v < 0) { result.parseError = `ping: invalid argument: '${next}' (must be >= 0)`; return result; }
        result.size = v; i++; continue;
      }
      if (a === '-t') {
        if (!next) { result.parseError = `ping: option requires an argument -- t\n${PING_USAGE}`; return result; }
        const v = parseInt(next, 10);
        if (isNaN(v) || !Number.isInteger(parseFloat(next))) { result.parseError = `ping: invalid argument: '${next}'`; return result; }
        if (v < 1 || v > 255) { result.parseError = `ping: invalid argument: '${next}' for option -t (valid range: 1-255)`; return result; }
        result.ttl = v; i++; continue;
      }
      if (a === '-W') {
        if (!next) { result.parseError = `ping: option requires an argument -- W\n${PING_USAGE}`; return result; }
        const v = parseFloat(next);
        if (isNaN(v) || !/^[\d.]+$/.test(next)) { result.parseError = `ping: invalid argument: '${next}'`; return result; }
        result.timeoutMs = Math.round(v * 1000); i++; continue;
      }
      if (a === '-i') {
        if (!next) { result.parseError = `ping: option requires an argument -- i\n${PING_USAGE}`; return result; }
        const v = parseFloat(next);
        if (isNaN(v) || !/^[\d.]+$/.test(next)) { result.parseError = `ping: invalid argument: '${next}'`; return result; }
        result.intervalMs = Math.round(v * 1000); i++; continue;
      }
      if (a === '-I') {
        if (!next) { result.parseError = `ping: option requires an argument -- I\n${PING_USAGE}`; return result; }
        if ((next.startsWith('"') && !next.endsWith('"')) || (next.startsWith("'") && !next.endsWith("'"))) {
          result.parseError = `ping: invalid syntax — unclosed quote in interface name '${next}'`; return result;
        }
        result.iface = next; i++; continue;
      }
      if (a === '-p') {
        if (next === undefined) { result.parseError = `ping: option requires an argument -- p\n${PING_USAGE}`; return result; }
        if (next === '') { result.parseError = 'ping: invalid argument: pattern cannot be empty'; return result; }
        if (!/^[0-9a-fA-F]+$/.test(next)) { result.parseError = `ping: invalid argument: '${next}' for option -p (must be hex digits)`; return result; }
        result.pattern = next.toLowerCase(); i++; continue;
      }
      if (a === '-M') {
        if (!next) { result.parseError = `ping: option requires an argument -- M\n${PING_USAGE}`; return result; }
        if (next !== 'do' && next !== 'want' && next !== 'dont') { result.parseError = `ping: invalid argument: '${next}' for option -M (valid: do, want, dont)`; return result; }
        result.mtuDisc = next; i++; continue;
      }
      if (a.startsWith('-')) continue;
      if (!result.targetGiven) { result.targetStr = a; result.targetGiven = true; }
      else result.extraTargets.push(a);
    }
    return result;
  }

  private header(target: string, size: number, hostname?: string): string {
    const totalSize = size + IP_HEADER_SIZE + ICMP_HEADER_SIZE;
    return `PING ${hostname ?? target} (${target}) ${size}(${totalSize}) bytes of data.`;
  }

  private replyLine(r: IcmpEchoReply, size: number, timestamp: boolean): string {
    const replySize = size + ICMP_HEADER_SIZE;
    let line: string;
    if (r.success) {
      line = `${replySize} bytes from ${r.fromIP}: icmp_seq=${r.seq} ttl=${r.ttl} time=${r.rttMs.toFixed(3)} ms`;
    } else if (r.error?.includes('Time to live exceeded')) {
      const m = r.error.match(/from ([\d.]+)/);
      line = `From ${m ? m[1] : 'unknown'} icmp_seq=${r.seq} Time to live exceeded`;
    } else if (r.error?.includes('Destination unreachable') || r.error?.includes('Network is unreachable')) {
      const m = r.error.match(/from ([\d.]+)/);
      line = m
        ? `From ${m[1]} icmp_seq=${r.seq} Destination Host Unreachable`
        : `From ${r.fromIP || 'unknown'} icmp_seq=${r.seq} Destination Host Unreachable`;
    } else {
      return '';
    }
    if (timestamp) return `[${(Date.now() / 1000).toFixed(6)}] ${line}`;
    return line;
  }

  private stats(targetStr: string, count: number, results: readonly IcmpEchoReply[]): string[] {
    const received = results.filter((r) => r.success);
    const lost = count - received.length;
    const lossPercent = count === 0 ? 0 : Math.round((lost / count) * 100);
    const lines = [
      '',
      `--- ${targetStr} ping statistics ---`,
      `${count} packets transmitted, ${received.length} received, ${lossPercent}% packet loss`,
    ];
    if (received.length > 0) {
      const rtts = received.map((r) => r.rttMs);
      const min = Math.min(...rtts).toFixed(3);
      const max = Math.max(...rtts).toFixed(3);
      const avg = (rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(3);
      const mdev = Math.sqrt(rtts.reduce((s, r) => s + (r - +avg) ** 2, 0) / rtts.length).toFixed(3);
      lines.push(`rtt min/avg/max/mdev = ${min}/${avg}/${max}/${mdev} ms`);
    } else if (lossPercent === 100) {
      lines.push('ping: destination host unreachable');
    }
    return lines;
  }

  private renderPing6(target: string, count: number, results: readonly IcmpEchoReply[], size: number): string {
    const lines: string[] = [`PING ${target}(${target}) ${size} data bytes`];
    if (results.length === 0) {
      lines.push('connect: Network is unreachable');
    } else {
      for (const r of results) {
        const line = this.replyLine(r, size, false);
        if (line) lines.push(line);
      }
    }
    lines.push(...this.stats(target, count, results));
    return lines.join('\n');
  }
}

export class Ping6Command extends PingCommand {
  override readonly descriptor: CommandDescriptor = {
    name: 'ping6',
    summary: 'Send ICMPv6 ECHO_REQUEST packets to network hosts (alias for ping -6).',
    usage: 'ping6 [-c count] [-s size] [-W timeout] [-i interval] <destination>',
    args: [{ name: 'argv', type: 'string', required: false, variadic: true, description: 'options et destination' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'réseau',
    lenientOptions: true,
    streaming: true,
  };

  protected override get commandName(): 'ping' | 'ping6' { return 'ping6'; }
}

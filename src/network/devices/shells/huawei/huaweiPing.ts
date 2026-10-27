import { looksLikeIPv6 } from '../cisco/ciscoPing';

export interface HuaweiEchoArguments {
  readonly target: string;
  readonly ipv6: boolean;
  readonly count: number;
  readonly timeoutMs: number;
  readonly sourceIP: string | null;
}

export interface HuaweiTracertArguments {
  readonly target: string;
  readonly ipv6: boolean;
  readonly maxHops: number;
  readonly timeoutMs: number;
  readonly probesPerHop: number;
}

export interface HuaweiPingRow {
  readonly success: boolean;
  readonly rttMs: number;
  readonly ttl: number;
  readonly seq: number;
  readonly fromIP: string;
}

export interface HuaweiTracertProbe {
  readonly responded: boolean;
  readonly rttMs?: number;
  readonly ip?: string;
  readonly unreachable?: boolean;
}

export interface HuaweiTracertHop {
  readonly hop: number;
  readonly ip?: string;
  readonly rttMs?: number;
  readonly timeout: boolean;
  readonly unreachable?: boolean;
  readonly probes?: readonly HuaweiTracertProbe[];
}

const MISSING_DESTINATION = 'Error: Please specify a destination IP address.';
const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function checkedTarget(target: string, ipv6: boolean): string | null {
  if (ipv6 || looksLikeIPv6(target)) {
    return looksLikeIPv6(target) ? null : `Error: Unknown host ${target}.`;
  }
  const literal = IPV4_LITERAL.exec(target);
  if (!literal) return `Error: Unknown host ${target}.`;
  if ([literal[1], literal[2], literal[3], literal[4]].some((octet) => Number(octet) > 255)) {
    return `Error: Invalid IP address ${target}.`;
  }
  return null;
}

function withoutFamilyKeyword(args: readonly string[]): { ipv6: boolean; rest: readonly string[] } {
  if (args[0]?.toLowerCase() === 'ipv6') return { ipv6: true, rest: args.slice(1) };
  return { ipv6: false, rest: args };
}

export function parseHuaweiPing(args: readonly string[]): HuaweiEchoArguments | string {
  if (args.length === 0) return MISSING_DESTINATION;
  const { ipv6: announced, rest } = withoutFamilyKeyword(args);
  if (rest.length === 0) return MISSING_DESTINATION;

  let target = '';
  let count = 5;
  let timeoutMs = 2000;
  let sourceIP: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i].toLowerCase();
    if (word === '-c' && rest[i + 1]) { count = parseInt(rest[i + 1], 10) || 5; i++; }
    else if (word === '-t' && rest[i + 1]) { timeoutMs = (parseInt(rest[i + 1], 10) || 2) * 1000; i++; }
    else if (word === '-a' && rest[i + 1]) { sourceIP = rest[i + 1]; i++; }
    else if (!word.startsWith('-')) { target = rest[i]; }
  }
  if (!target) return MISSING_DESTINATION;

  const refusal = checkedTarget(target, announced);
  if (refusal !== null) return refusal;
  return { target, ipv6: announced || looksLikeIPv6(target), count, timeoutMs, sourceIP };
}

export function parseHuaweiTracert(args: readonly string[]): HuaweiTracertArguments | string {
  if (args.length === 0) return MISSING_DESTINATION;
  const { ipv6: announced, rest } = withoutFamilyKeyword(args);

  let target = '';
  let maxHops = 30;
  let timeoutMs = 2000;
  let probesPerHop = 3;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i].toLowerCase();
    if (word === '-h' && rest[i + 1]) { maxHops = parseInt(rest[i + 1], 10) || 30; i++; }
    else if (word === '-w' && rest[i + 1]) { timeoutMs = (parseInt(rest[i + 1], 10) || 2) * 1000; i++; }
    else if (word === '-q' && rest[i + 1]) { probesPerHop = parseInt(rest[i + 1], 10) || 3; i++; }
    else if (!word.startsWith('-')) { target = rest[i]; }
  }
  if (!target) return MISSING_DESTINATION;

  const refusal = checkedTarget(target, announced);
  if (refusal !== null) return refusal;
  return { target, ipv6: announced || looksLikeIPv6(target), maxHops, timeoutMs, probesPerHop };
}

function silentProbes(count: number): HuaweiPingRow[] {
  return Array.from({ length: count }, (_, index) => ({
    success: false, rttMs: 0, ttl: 0, seq: index + 1, fromIP: '',
  }));
}

export function formatHuaweiPing(target: string, count: number, probes: readonly HuaweiPingRow[]): string {
  const results = probes.length === 0 ? silentProbes(count) : probes;
  const successes = results.filter((row) => row.success).length;
  return [
    `PING ${target}: 56  data bytes, press CTRL_C to break`,
    ...results.map((row) => row.success
      ? `Reply from ${row.fromIP}: bytes=56 Sequence=${row.seq} ttl=${row.ttl} time=${row.rttMs.toFixed(0)} ms`
      : 'Request timeout'),
    '',
    `--- ${target} ping statistics ---`,
    `${count} packet(s) transmitted, ${successes} packet(s) received, ${Math.round(((count - successes) / count) * 100)}% packet loss`,
  ].join('\n');
}

export function formatHuaweiPing6(target: string, count: number, probes: readonly HuaweiPingRow[]): string {
  const results = probes.length === 0 ? silentProbes(count) : probes;
  const received = results.filter((row) => row.success);
  const rtts = received.map((row) => Math.round(row.rttMs));
  const loss = count === 0 ? 0 : ((count - received.length) / count) * 100;
  const lines = [`  PING ${target} : 56  data bytes, press CTRL_C to break`];
  for (const row of results) {
    if (!row.success) { lines.push('    Request time out'); continue; }
    lines.push(`    Reply from ${row.fromIP}`);
    lines.push(`    bytes=56 Sequence=${row.seq} hop limit=${row.ttl}  time = ${Math.round(row.rttMs)} ms`);
  }
  lines.push('');
  lines.push(`  --- ${target} ping statistics ---`);
  lines.push(`    ${count} packet(s) transmitted`);
  lines.push(`    ${received.length} packet(s) received`);
  lines.push(`    ${loss.toFixed(2)}% packet loss`);
  if (rtts.length > 0) {
    const average = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
    lines.push(`    round-trip min/avg/max = ${Math.min(...rtts)}/${average}/${Math.max(...rtts)} ms`);
  }
  return lines.join('\n');
}

export function formatHuaweiTracert(target: string, maxHops: number, hops: readonly HuaweiTracertHop[]): string {
  const lines: string[] = [
    `tracert to ${target}(${target}), max hops: ${maxHops}, packet length: 40, press CTRL_C to break`,
  ];
  if (hops.length === 0) {
    lines.push(' Network is unreachable');
    return lines.join('\n');
  }
  for (const hop of hops) {
    if (hop.timeout && (!hop.probes || hop.probes.every((probe) => !probe.responded))) {
      lines.push(` ${hop.hop}  *  *  *`);
      continue;
    }
    const annotation = hop.unreachable ? ' !N' : '';
    if (hop.probes && hop.probes.length > 0) {
      const marks = hop.probes.map((probe) => probe.responded ? `${Math.round(probe.rttMs ?? 0)} ms` : '*');
      lines.push(` ${hop.hop} ${hop.ip}  ${marks.join(' ')}${annotation}`);
    } else {
      lines.push(` ${hop.hop} ${hop.ip}  ${Math.round(hop.rttMs ?? 0)} ms${annotation}`);
    }
  }
  return lines.join('\n');
}

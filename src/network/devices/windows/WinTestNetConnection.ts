export type TestNetConnectionLevel = 'standard' | 'detailed' | 'quiet';

export interface ParsedWinTestNetConnection {
  target: string;
  port?: number;
  level: TestNetConnectionLevel;
}

const COMMON_TCP_PORTS: Record<string, number> = {
  http: 80,
  smb: 445,
  rdp: 3389,
  winrm: 5985,
  winrmhttp: 5985,
  winrmhttps: 5986,
};

export function parseWinTestNetConnectionArgs(args: string[]): ParsedWinTestNetConnection | null {
  let target = '';
  let port: number | undefined;
  let level: TestNetConnectionLevel = 'standard';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const lower = a.toLowerCase();
    if (lower === '-computername' || lower === '-cn' || lower === '-targetname') {
      target = args[++i] ?? '';
    } else if (lower === '-port' || lower === '-remoteport') {
      const v = Number(args[++i]);
      if (Number.isFinite(v) && v > 0) port = v;
    } else if (lower === '-commontcpport') {
      const name = (args[++i] ?? '').toLowerCase();
      if (COMMON_TCP_PORTS[name] !== undefined) port = COMMON_TCP_PORTS[name];
    } else if (lower === '-informationlevel') {
      const v = (args[++i] ?? '').toLowerCase();
      if (v === 'detailed') level = 'detailed';
      else if (v === 'quiet') level = 'quiet';
    } else if (lower === '-hops' || lower === '-diagnoserouting' || lower === '-constrainsourceaddress'
        || lower === '-constraininterface' || lower === '-dnsonly' || lower === '-traceroute') {
      if (lower === '-hops' || lower === '-constrainsourceaddress' || lower === '-constraininterface') i++;
    } else if (lower === '-erroraction') {
      i++;
    } else if (!lower.startsWith('-') && !target) {
      target = a;
    }
  }

  if (!target) return null;
  target = stripQuotes(target);
  return { target, port, level };
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

export interface TestNetConnectionResult {
  computerName: string;
  remoteAddress: string;
  remotePort?: number;
  nameResolved: boolean;
  interfaceAlias: string;
  sourceAddress: string;
  netRouteNextHop: string;
  pingSucceeded: boolean;
  pingRttMs: number;
  tcpTested: boolean;
  tcpSucceeded: boolean;
  level: TestNetConnectionLevel;
}

function field(label: string, value: string, width: number): string {
  return `${label.padEnd(width)} : ${value}`;
}

function bool(v: boolean): string { return v ? 'True' : 'False'; }

function rttCell(ms: number): string {
  const r = Math.round(ms);
  return `${r} ms`;
}

export function formatWinTestNetConnection(r: TestNetConnectionResult): string[] {
  if (r.level === 'quiet') {
    const ok = r.tcpTested ? r.tcpSucceeded : r.pingSucceeded;
    return [bool(ok)];
  }

  const lines: string[] = [''];
  if (!r.pingSucceeded) {
    lines.push(`WARNING: Ping to ${r.computerName} failed with status: TimedOut`);
  }
  if (r.tcpTested && !r.tcpSucceeded) {
    lines.push(`WARNING: TCP connect to ${r.remoteAddress}:${r.remotePort} failed`);
  }

  const detailed = r.level === 'detailed';
  const w = detailed ? 23 : 16;
  lines.push(field('ComputerName', r.computerName, w));
  lines.push(field('RemoteAddress', r.remoteAddress, w));
  if (r.tcpTested && r.remotePort !== undefined) {
    lines.push(field('RemotePort', String(r.remotePort), w));
  }
  if (detailed) {
    lines.push(field('NameResolutionResults', r.nameResolved ? r.remoteAddress : '', w));
  }
  lines.push(field('InterfaceAlias', r.interfaceAlias, w));
  lines.push(field('SourceAddress', r.sourceAddress, w));
  if (detailed) {
    lines.push(field('NetRoute (NextHop)', r.netRouteNextHop, w));
  }
  lines.push(field('PingSucceeded', bool(r.pingSucceeded), w));
  lines.push(field('PingReplyDetails (RTT)', rttCell(r.pingSucceeded ? r.pingRttMs : 0), w));
  if (r.tcpTested) {
    lines.push(field('TcpTestSucceeded', bool(r.tcpSucceeded), w));
  }
  lines.push('');
  return lines;
}

import type { NmapOptions } from './NmapOptions';
import { topPorts, serviceName, DEFAULT_TOP_COUNT } from './ServiceRegistry';

export type PortState = 'open' | 'closed' | 'filtered' | 'open|filtered';

export interface HostState {
  ip: string;
  hostname?: string;
  up: boolean;
  poweredOff?: boolean;
  interfaceDown?: boolean;
  osHint?: string;
  latencyMs?: number;
}

export interface HostProbes {
  hostState(target: string): HostState | null;
  tcpOutcome(ip: string, port: number): 'open' | 'refused' | 'timeout';
  udpState(ip: string, port: number): 'open' | 'closed' | 'open|filtered';
  banner(ip: string, port: number): { service: string; version?: string } | null;
}

export interface PortResult {
  port: number;
  protocol: 'tcp' | 'udp';
  state: PortState;
  service: string;
  version?: string;
  reason: string;
}

export interface HostReport {
  ip: string;
  hostname?: string;
  up: boolean;
  latencyMs: number;
  osGuess?: string;
  downReason?: string;
  ports: PortResult[];
  notShown?: { count: number; states: Partial<Record<PortState, number>> };
}

export interface NmapReport {
  startedAt: string;
  targetsScanned: number;
  hostsUp: number;
  hosts: HostReport[];
  unresolved: string[];
}

const COLLAPSE_THRESHOLD = 24;
const MAX_CIDR_HOSTS = 1024;

export function enumerateTargets(target: string): string[] {
  const slash = target.indexOf('/');
  if (slash < 0) return [target];

  const base = target.slice(0, slash);
  const prefix = Number(target.slice(slash + 1));
  const octets = base.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return [target];
  }
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return [target];

  const count = 2 ** (32 - prefix);
  if (count > MAX_CIDR_HOSTS) return [target];

  const baseInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const network = prefix === 0 ? 0 : (baseInt & (0xffffffff << (32 - prefix))) >>> 0;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const addr = (network + i) >>> 0;
    out.push([addr >>> 24, (addr >>> 16) & 255, (addr >>> 8) & 255, addr & 255].join('.'));
  }
  return out;
}

function effectivePorts(options: NmapOptions): number[] {
  return options.ports ?? topPorts(DEFAULT_TOP_COUNT);
}

function tcpResult(options: NmapOptions, probes: HostProbes, ip: string, port: number): PortResult {
  const outcome = probes.tcpOutcome(ip, port);
  const state: PortState = outcome === 'open' ? 'open' : outcome === 'refused' ? 'closed' : 'filtered';
  const reason = outcome === 'open' ? 'syn-ack' : outcome === 'refused' ? 'reset' : 'no-response';
  let service = serviceName(port, 'tcp');
  let version: string | undefined;
  if (options.versionScan && state === 'open') {
    const detected = probes.banner(ip, port);
    if (detected) {
      service = detected.service;
      version = detected.version;
    }
  }
  return { port, protocol: 'tcp', state, service, version, reason };
}

function udpResult(options: NmapOptions, probes: HostProbes, ip: string, port: number): PortResult {
  const state = probes.udpState(ip, port);
  const reason = state === 'open' ? 'udp-response' : state === 'closed' ? 'port-unreach' : 'no-response';
  let service = serviceName(port, 'udp');
  let version: string | undefined;
  if (options.versionScan && state === 'open') {
    const detected = probes.banner(ip, port);
    if (detected) {
      service = detected.service;
      version = detected.version;
    }
  }
  return { port, protocol: 'udp', state, service, version, reason };
}

function partition(options: NmapOptions, all: PortResult[]): Pick<HostReport, 'ports' | 'notShown'> {
  const shownStates = new Set<PortState>(options.openOnly ? ['open'] : ['open', 'open|filtered']);
  const byState = new Map<PortState, number>();
  for (const p of all) byState.set(p.state, (byState.get(p.state) ?? 0) + 1);

  const collapsed = new Set<PortState>();
  for (const [state, count] of byState) {
    if (shownStates.has(state)) continue;
    if (options.openOnly || count > COLLAPSE_THRESHOLD) collapsed.add(state);
  }

  const ports = all.filter((p) => !collapsed.has(p.state));
  if (collapsed.size === 0) return { ports };

  const states: Partial<Record<PortState, number>> = {};
  let total = 0;
  for (const state of collapsed) {
    const n = byState.get(state) ?? 0;
    states[state] = n;
    total += n;
  }
  return { ports, notShown: { count: total, states } };
}

function scanHost(options: NmapOptions, probes: HostProbes, target: string): HostReport | null {
  const info = probes.hostState(target) ?? (options.skipDiscovery ? { ip: target, up: true } : null);
  if (!info) return null;

  const forcedUp = options.skipDiscovery || info.up;
  const latencyMs = info.latencyMs ?? 0.001;
  const osGuess = options.osScan ? info.osHint : undefined;

  if (!forcedUp) {
    const downReason = info.poweredOff ? 'powered off' : info.interfaceDown ? 'interface down' : 'no response';
    return { ip: info.ip, hostname: info.hostname, up: false, latencyMs, downReason, ports: [] };
  }

  if (options.pingOnly) {
    return { ip: info.ip, hostname: info.hostname, up: true, latencyMs, osGuess, ports: [] };
  }

  const all = effectivePorts(options).map((port) =>
    options.scanType === 'udp'
      ? udpResult(options, probes, info.ip, port)
      : tcpResult(options, probes, info.ip, port),
  );
  const { ports, notShown } = partition(options, all);
  return { ip: info.ip, hostname: info.hostname, up: true, latencyMs, osGuess, ports, notShown };
}

export function scan(options: NmapOptions, probes: HostProbes): NmapReport {
  const hosts: HostReport[] = [];
  const unresolved: string[] = [];
  let targetsScanned = 0;

  for (const target of options.targets) {
    for (const address of enumerateTargets(target)) {
      const report = scanHost(options, probes, address);
      if (!report) {
        if (target === address) unresolved.push(address);
        continue;
      }
      targetsScanned++;
      if (options.pingOnly && !report.up) continue;
      hosts.push(report);
    }
  }

  return {
    startedAt: new Date().toISOString(),
    targetsScanned,
    hostsUp: hosts.filter((h) => h.up).length,
    hosts,
    unresolved,
  };
}

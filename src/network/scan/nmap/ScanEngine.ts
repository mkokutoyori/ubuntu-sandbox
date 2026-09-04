import type { NmapOptions, ScanType } from './NmapOptions';
import { IPAddress } from '@/network/core/types';
import type { TcpWireOutcome } from '@/network/tcp/types';
import { topPorts, serviceName, DEFAULT_TOP_COUNT } from './ServiceRegistry';
import type { ScanVerdict, StatelessScanKind } from './StatelessScans';

const STATELESS_KINDS: Readonly<Partial<Record<ScanType, StatelessScanKind>>> = {
  syn: 'syn', ack: 'ack', fin: 'fin', null: 'null',
  xmas: 'xmas', maimon: 'maimon', window: 'window',
};

function statelessKindOf(scanType: ScanType): StatelessScanKind | undefined {
  return STATELESS_KINDS[scanType];
}

export type PortState = 'open' | 'closed' | 'filtered' | 'open|filtered' | 'unfiltered';

export interface HostState {
  ip: string;
  hostname?: string;
  up: boolean;
  poweredOff?: boolean;
  interfaceDown?: boolean;
  osHint?: string;
  latencyMs?: number;
  mac?: string;
  reason?: string;
}

export interface ResolvedTarget {
  ip: string;
  hostname?: string;
}

export interface HostProbes {
  /** Name to address. A lookup, never a liveness test. */
  resolveTarget(target: string): ResolvedTarget | null;
  /** Emits the discovery probes and reports what came back. */
  hostState(target: ResolvedTarget): Promise<HostState>;
  /**
   * La decouverte de couche lien d'une cible du MEME segment — ARP en
   * IPv4, decouverte de voisin en IPv6. Les TROIS issues sont distinctes
   * et le rester importe : `null` veut dire que la cible n'est pas sur ce
   * segment, donc que les sondes IP reprennent la main ; `mac: null` veut
   * dire qu'elle y est et n'a pas repondu, donc qu'elle est absente.
   */
  linkDiscovery?(ip: string): { mac: string | null; reason: string } | null;
  /**
   * `-O` is a phase of its own on a real nmap (FPEngine), run after the
   * port scan and independent of host discovery — so it still fingerprints
   * under `-Pn`, where no discovery probe was ever sent.
   */
  fingerprint?(ip: string): Promise<string | undefined>;
  tcpOutcome(ip: string, port: number): TcpWireOutcome;
  /** Les balayages qui n'ouvrent rien : SYN, ACK, FIN, NULL, Xmas, Maimon, fenetre. */
  statelessOutcome?(ip: string, port: number, kind: StatelessScanKind): ScanVerdict;
  udpState(ip: string, port: number): 'open' | 'closed' | 'open|filtered';
  banner(ip: string, port: number): { service: string; version?: string } | null;
}

const TCP_SCAN_REASON: Readonly<Record<TcpWireOutcome, string>> = {
  open: 'syn-ack',
  refused: 'reset',
  prohibited: 'admin-prohibited',
  timeout: 'no-response',
  unreachable: 'net-unreach',
};

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
  mac?: string;
  discoveryReason?: string;
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

function tcpResult(
  options: NmapOptions, probes: HostProbes, ip: string, port: number,
): PortResult {
  const kind = statelessKindOf(options.scanType);
  const stateless = kind && probes.statelessOutcome
    ? probes.statelessOutcome(ip, port, kind) : null;
  let state: PortState;
  let reason: string;
  if (stateless) {
    state = stateless.state;
    reason = stateless.reason;
  } else {
    const outcome = probes.tcpOutcome(ip, port);
    // scan_engine_connect.cc : ECONNREFUSED ferme le port, EACCES — que
    // provoque un inatteignable « administrativement interdit » — le
    // FILTRE. Les confondre fait passer une liste de controle pour un
    // service absent.
    state = outcome === 'open' ? 'open' : outcome === 'refused' ? 'closed' : 'filtered';
    reason = TCP_SCAN_REASON[outcome];
  }
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

function udpResult(
  options: NmapOptions, probes: HostProbes, ip: string, port: number,
): PortResult {
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

async function scanHost(
  options: NmapOptions, probes: HostProbes, target: string,
): Promise<HostReport | null> {
  const resolved = probes.resolveTarget(target);
  if (!resolved) return null;

  // targets.cc, `refresh_hostbatch` : la decouverte de couche lien passe
  // AVANT toute sonde IP, elle les remplace quand elle repond, et le
  // manuel dit qu'elle a lieu « even if other host discovery options such
  // as -Pn or -PE are used » — donc une adresse locale que personne ne
  // porte ressort `down` sous `-Pn` aussi. `--disable-arp-ping` la
  // desarme, et `-Pn` retrouve alors son sens litteral.
  const onLink = options.disableArpPing ? null : probes.linkDiscovery?.(resolved.ip);
  const identified = { ip: resolved.ip, hostname: resolved.hostname };
  const info: HostState = onLink
    ? { ...identified, up: onLink.mac !== null, mac: onLink.mac ?? undefined, reason: onLink.reason }
    : options.skipDiscovery
      ? { ...identified, up: true, reason: 'user-set' }
      : await probes.hostState(resolved);

  const latencyMs = info.latencyMs ?? 0.001;
  const osGuess = options.osScan
    ? info.osHint ?? await probes.fingerprint?.(info.ip)
    : undefined;

  if (!info.up) {
    return {
      ip: info.ip, hostname: info.hostname, up: false, latencyMs,
      downReason: 'no response', ports: [],
    };
  }

  const identity = { mac: info.mac, discoveryReason: info.reason };

  if (options.pingOnly) {
    return {
      ip: info.ip, hostname: info.hostname, up: true, latencyMs, osGuess,
      ...identity, ports: [],
    };
  }

  const all: PortResult[] = [];
  for (const port of effectivePorts(options)) {
    if (options.scanType === 'udp') all.push(udpResult(options, probes, info.ip, port));
    else all.push(tcpResult(options, probes, info.ip, port));
  }
  const { ports, notShown } = partition(options, all);
  return {
    ip: info.ip, hostname: info.hostname, up: true, latencyMs, osGuess,
    ...identity, ports, notShown,
  };
}

function isIpLiteral(target: string): boolean {
  return IPAddress.tryParse(target) !== null;
}

export async function scan(
  options: NmapOptions, probes: HostProbes,
): Promise<NmapReport> {
  const hosts: HostReport[] = [];
  const unresolved: string[] = [];
  let targetsScanned = 0;

  for (const target of options.targets) {
    for (const address of enumerateTargets(target)) {
      const report = await scanHost(options, probes, address)
        ?? (target === address && isIpLiteral(address)
          ? { ip: address, up: false, latencyMs: 0, downReason: 'no response', ports: [] }
          : null);
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

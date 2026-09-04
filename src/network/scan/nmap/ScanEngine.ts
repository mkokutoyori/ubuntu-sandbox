import type { NmapOptions, ScanType } from './NmapOptions';
import { IPAddress } from '@/network/core/types';
import type { TcpWireOutcome } from '@/network/tcp/types';
import { topPorts, serviceName, DEFAULT_TOP_COUNT } from './ServiceRegistry';
import type { ScanProbeFlags, ScanVerdict, StatelessScanKind } from './StatelessScans';
import {
  ARP_PING_PHASE, IP_PING_PHASE, ND_PING_PHASE, SCAN_PHASE_NAME, type ScanPhase,
} from './ScanPhases';
import {
  chooseTraceProbe, type HostTrace, type TraceCandidate, type TraceHop,
} from './Traceroute';

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
  /**
   * Le port qui a fait repondre l'hote, quand c'est une sonde TCP qui a
   * repondu. `--traceroute` le lit pour nommer sa propre sonde, comme
   * `get_probe` lit `target->pingprobe`.
   */
  reasonPort?: number;
  /**
   * Le TTL de la reponse de decouverte. `--reason` l'ecrit apres la
   * raison (`output.cc:1457`) ; une reponse ARP n'en porte aucun.
   */
  replyTtl?: number;
}

export interface ResolvedTarget {
  ip: string;
  hostname?: string;
}

export interface HostProbes {
  /** Name to address. A lookup, never a liveness test. */
  resolveTarget(target: string): ResolvedTarget | null | Promise<ResolvedTarget | null>;
  /** Emits the discovery probes and reports what came back. */
  hostState(target: ResolvedTarget): Promise<HostState>;
  /**
   * La decouverte de couche lien d'une cible du MEME segment — ARP en
   * IPv4, decouverte de voisin en IPv6. Les TROIS issues sont distinctes
   * et le rester importe : `null` veut dire que la cible n'est pas sur ce
   * segment, donc que les sondes IP reprennent la main ; `mac: null` veut
   * dire qu'elle y est et n'a pas repondu, donc qu'elle est absente.
   */
  linkDiscovery?(
    ip: string,
  ): { mac: string | null; reason: string; rttMs?: number } | null;
  /**
   * Le nom d'une adresse. `nmap` le demande pour tout hote trouve VIVANT,
   * et `-R` l'etend a ceux qui ne repondent pas.
   */
  reverseName?(ip: string): Promise<string | null>;
  /**
   * `-O` is a phase of its own on a real nmap (FPEngine), run after the
   * port scan and independent of host discovery — so it still fingerprints
   * under `-Pn`, where no discovery probe was ever sent.
   */
  fingerprint?(ip: string): Promise<string | undefined>;
  tcpOutcome(ip: string, port: number): TcpWireOutcome;
  /**
   * Les balayages qui n'ouvrent rien : SYN, ACK, FIN, NULL, Xmas, Maimon,
   * fenetre. `kind` decide la LECTURE de la reponse, `flags` ce qui est
   * EMIS — les deux se separent des que `--scanflags` compose le segment.
   */
  statelessOutcome?(
    ip: string, port: number, kind: StatelessScanKind, flags?: ScanProbeFlags,
  ): ScanVerdict;
  udpState(ip: string, port: number): 'open' | 'closed' | 'open|filtered';
  banner(ip: string, port: number): { service: string; version?: string } | null;
  /**
   * `Target::directlyConnected()` : une cible du meme segment est a une
   * distance connue de 1, et `traceroute_direct` (`traceroute.cc:1461`)
   * n'emet alors AUCUNE sonde.
   */
  directlyConnected?(ip: string): boolean;
  /** La marche par duree de vie limitee, celle de la machine. */
  tracePath?(ip: string): Promise<Array<{
    ttl: number; ip?: string; rttMs?: number;
  }>>;
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
  /** Ce que la resolution inverse a rendu, quand elle a ete faite. */
  rdnsName?: string;
  /** Le TTL de la reponse de decouverte, ce que `--reason` ecrit apres elle. */
  replyTtl?: number;
  ports: PortResult[];
  notShown?: { count: number; states: Partial<Record<PortState, number>> };
  /** Ce que `--traceroute` a releve, quand il a ete demande. */
  trace?: HostTrace;
}

export interface NmapReport {
  startedAt: string;
  targetsScanned: number;
  hostsUp: number;
  hosts: HostReport[];
  unresolved: string[];
  /** Ce que `-v` rend visible : les phases traversees, dans l'ordre. */
  phases: ScanPhase[];
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
    ? probes.statelessOutcome(ip, port, kind, options.scanFlags) : null;
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

/**
 * La phase de decouverte porte le nom du moyen REELLEMENT employe : le
 * lien quand il a repondu, les sondes IP sinon, et rien du tout sous
 * `-Pn`, ou aucune decouverte n'a lieu.
 */
function discoveryPhase(
  ip: string, onLink: { mac: string | null } | null | undefined, skipped: boolean,
): ScanPhase | null {
  if (onLink) {
    return { name: ip.includes(':') ? ND_PING_PHASE : ARP_PING_PHASE, total: 1, unit: 'host' };
  }
  if (skipped) return null;
  return { name: IP_PING_PHASE, total: 1, unit: 'host' };
}

/**
 * Ce que `target->pingprobe` porte a la fin du balayage : la sonde de
 * decouverte qui a repondu, puis chaque port dont la reponse est arrivee
 * — un port muet n'est candidat a rien.
 */
function traceCandidates(info: HostState, ports: readonly PortResult[]): TraceCandidate[] {
  const family: 4 | 6 = info.ip.includes(':') ? 6 : 4;
  const out: TraceCandidate[] = [];
  if (info.reason === 'echo-reply') out.push({ kind: 'icmp-echo', family });
  if ((info.reason === 'syn-ack' || info.reason === 'reset') && info.reasonPort !== undefined) {
    out.push({
      kind: 'tcp', port: info.reasonPort,
      state: info.reason === 'syn-ack' ? 'open' : 'closed',
    });
  }
  for (const port of ports) {
    if (port.protocol !== 'tcp' || port.reason === 'no-response') continue;
    if (port.state === 'open') out.push({ kind: 'tcp', port: port.port, state: 'open' });
    else if (port.state === 'closed') out.push({ kind: 'tcp', port: port.port, state: 'closed' });
    else if (port.state === 'filtered') out.push({ kind: 'tcp', port: port.port, state: 'filtered' });
  }
  return out;
}

async function buildTrace(
  options: NmapOptions, probes: HostProbes, info: HostState,
  latencyMs: number, rdnsName: string | undefined,
  ports: readonly PortResult[], cache: Map<string, string>,
): Promise<HostTrace | undefined> {
  const family: 4 | 6 = info.ip.includes(':') ? 6 : 4;

  if (probes.directlyConnected?.(info.ip)) {
    return {
      probe: { kind: 'none' },
      hops: [{
        ttl: 1, ip: info.ip, rttMs: latencyMs,
        name: info.hostname ?? rdnsName, tag: info.ip,
      }],
    };
  }

  const walked = await probes.tracePath?.(info.ip);
  if (!walked || walked.length === 0) return undefined;

  const hops: TraceHop[] = [];
  for (const step of walked) {
    if (!step.ip) {
      hops.push({ ttl: step.ttl, tag: info.ip });
      continue;
    }
    const key = `${step.ttl}:${step.ip}`;
    const known = cache.get(key);
    if (known === undefined) cache.set(key, info.ip);
    const name = options.noDns ? undefined : await probes.reverseName?.(step.ip) ?? undefined;
    hops.push({
      ttl: step.ttl, ip: step.ip, rttMs: step.rttMs,
      name, tag: known ?? info.ip,
    });
  }
  return { probe: chooseTraceProbe(traceCandidates(info, ports), family), hops };
}

async function scanHost(
  options: NmapOptions, probes: HostProbes, target: string, phases: ScanPhase[],
  hopCache: Map<string, string>,
): Promise<HostReport | null> {
  const resolved = await probes.resolveTarget(target);
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
    ? {
        ...identified, up: onLink.mac !== null, mac: onLink.mac ?? undefined,
        reason: onLink.reason, latencyMs: onLink.rttMs,
      }
    : options.skipDiscovery
      ? { ...identified, up: true, reason: 'user-set' }
      : await probes.hostState(resolved);

  const discovery = discoveryPhase(resolved.ip, onLink, options.skipDiscovery);
  if (discovery) phases.push(discovery);

  const latencyMs = info.latencyMs ?? 0.001;
  const osGuess = options.osScan
    ? info.osHint ?? await probes.fingerprint?.(info.ip)
    : undefined;

  // docs/nmap.1 : la resolution inverse est faite par defaut sur les hotes
  // trouves EN LIGNE, `-n` l'interdit et `-R` l'etend a ceux qui ne
  // repondent pas.
  const rdnsName = options.noDns || !(info.up || options.alwaysResolve)
    ? undefined
    : await probes.reverseName?.(info.ip) ?? undefined;

  if (!info.up) {
    return {
      ip: info.ip, hostname: info.hostname, up: false, latencyMs,
      downReason: 'no-response', rdnsName, ports: [],
    };
  }

  const identity = {
    mac: info.mac, discoveryReason: info.reason, rdnsName, replyTtl: info.replyTtl,
  };

  if (options.pingOnly) {
    return {
      ip: info.ip, hostname: info.hostname, up: true, latencyMs, osGuess,
      ...identity, ports: [],
      trace: options.traceroute
        ? await buildTrace(options, probes, info, latencyMs, rdnsName, [], hopCache)
        : undefined,
    };
  }

  const scanned = effectivePorts(options);
  phases.push({
    name: SCAN_PHASE_NAME[options.scanType],
    total: scanned.length, unit: 'port',
    scanning: { target: info.ip, probes: scanned.length },
  });

  const all: PortResult[] = [];
  for (const port of scanned) {
    if (options.scanType === 'udp') all.push(udpResult(options, probes, info.ip, port));
    else all.push(tcpResult(options, probes, info.ip, port));
  }
  const { ports, notShown } = partition(options, all);
  return {
    ip: info.ip, hostname: info.hostname, up: true, latencyMs, osGuess,
    ...identity, ports, notShown,
    trace: options.traceroute
      ? await buildTrace(options, probes, info, latencyMs, rdnsName, all, hopCache)
      : undefined,
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
  const phases: ScanPhase[] = [];
  // Le cache de sauts du lot : deux cibles derriere le meme routeur
  // partagent leurs premiers sauts, et c'est ce qui fait ecrire
  // « Hops 1-N are the same as for … » plutot que de les repeter.
  const hopCache = new Map<string, string>();
  let targetsScanned = 0;

  for (const target of options.targets) {
    for (const address of enumerateTargets(target)) {
      const report = await scanHost(options, probes, address, phases, hopCache)
        ?? (target === address && isIpLiteral(address)
          ? { ip: address, up: false, latencyMs: 0, downReason: 'no-response', ports: [] }
          : null);
      if (!report) {
        if (target === address) unresolved.push(address);
        continue;
      }
      targetsScanned++;
      // nmap.cc:2143 : un hote MORT n'est rapporte que sous `-v`
      // (`HOST_UP || (o.verbose && !o.openOnly())`) — un balayage de
      // decouverte ordinaire ne liste que ce qu'il a trouve.
      if (options.pingOnly && !report.up && !options.verbose) continue;
      hosts.push(report);
    }
  }

  return {
    startedAt: new Date().toISOString(),
    targetsScanned,
    hostsUp: hosts.filter((h) => h.up).length,
    hosts,
    unresolved,
    phases,
  };
}

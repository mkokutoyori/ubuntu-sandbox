import type { NmapOptions, ScanType } from './NmapOptions';
import { IPAddress } from '@/network/core/types';
import type { TcpWireOutcome } from '@/network/tcp/types';
import type { ScanProbeShape } from '@/network/tcp/TcpStack';
import { topPorts, serviceName, DEFAULT_TOP_COUNT } from './ServiceRegistry';
import type { ScanProbeFlags, ScanVerdict, StatelessScanKind } from './StatelessScans';
import {
  ARP_PING_PHASE, IP_PING_PHASE, ND_PING_PHASE, SCAN_PHASE_NAME, type ScanPhase,
} from './ScanPhases';
import {
  chooseTraceProbe, type HostTrace, type TraceCandidate, type TraceHop,
} from './Traceroute';
import { addrSetContains, enumerateTargets } from './TargetSpec';
import {
  traceConnectLine, traceFrameLine, type TraceDirection,
} from './PacketTrace';
import type { EthernetFrame } from '@/network/core/types';

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
    shape?: ScanProbeShape,
  ): ScanVerdict;
  udpState(
    ip: string, port: number, shape?: ScanProbeShape,
  ): 'open' | 'closed' | 'open|filtered';
  banner(
    ip: string, port: number, intensity: number,
  ): { service: string; version?: string } | null;
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
  /**
   * Ce que la machine met sur le fil et en retire, pour `--packet-trace`.
   * Rend de quoi se desabonner : la trace ne dure que le balayage.
   */
  observeWire?(
    sink: (direction: TraceDirection, frame: EthernetFrame) => void,
  ): () => void;
}

/**
 * Ce que `--packet-trace` accumule pendant un balayage : les cibles que
 * le filtre laisse passer, les lignes deja rendues, et l'horloge depuis
 * le demarrage que chaque ligne porte.
 */
export interface TraceContext {
  readonly targets: Set<string>;
  readonly lines: string[];
  elapsed(): number;
  /**
   * Un balayage CONNECTE ne montre pas ses paquets : `connect()` laisse
   * le noyau les emettre, donc un vrai `nmap` ne les voit pas passer et
   * n'ecrit que ses lignes `CONN`.
   */
  readonly connectScan: boolean;
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

/**
 * Ce que `get_state_reason_summary` (`portreasons.cc:369`) rend : les
 * ports replies regroupes par etat, puis par RAISON et par protocole.
 * Garder la raison n'est pas un detail de XML — `output.cc:594` l'ecrit
 * dans la ligne humaine aussi, et c'est la seule moitie qui diagnostique,
 * un port muet et un port qui repond RST n'ayant pas la meme cause.
 */
export interface NotShownGroup {
  state: PortState;
  protocol: 'tcp' | 'udp';
  reason: string;
  ports: number[];
}

export interface NotShown {
  count: number;
  /**
   * Les etats, du plus peuple au moins peuple, et dans chacun les raisons
   * dans le meme ordre (`PortList::nextIgnoredState`, `reason_sort`).
   */
  groups: NotShownGroup[];
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
  notShown?: NotShown;
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
  /** Ce que `--packet-trace` rend visible, dans l'ordre des paquets. */
  packetTrace: string[];
}

const COLLAPSE_THRESHOLD = 24;

export function effectivePorts(options: NmapOptions): number[] {
  return options.ports ?? topPorts(DEFAULT_TOP_COUNT);
}

/**
 * `scan_engine_raw.cc:1218` : la boucle d'emission construit UNE sonde
 * par leurre, chacune avec SA source, et seule celle de rang `decoyturn`
 * est suivie. C'est ce qui fait qu'un balayage a leurres garde un
 * resultat JUSTE tout en noyant l'origine — une sonde partie d'une
 * adresse forgee ne peut rien recevoir, donc son verdict ne veut rien
 * dire et il est jete.
 */
function withDecoys<T>(
  options: NmapOptions, emit: (shape: ScanProbeShape | undefined) => T,
): T {
  if (!options.decoys) return emit(options.probeShape);
  let real: T | undefined;
  for (const decoy of options.decoys) {
    const shape = decoy.kind === 'me'
      ? options.probeShape
      : { ...options.probeShape, sourceIp: decoy.ip };
    const verdict = emit(shape);
    if (decoy.kind === 'me') real = verdict;
  }
  return real as T;
}

function tcpResult(
  options: NmapOptions, probes: HostProbes, ip: string, port: number,
  trace?: TraceContext,
): PortResult {
  const kind = statelessKindOf(options.scanType);
  const stateless = kind && probes.statelessOutcome
    ? withDecoys(options, (shape) =>
      probes.statelessOutcome!(ip, port, kind, options.scanFlags, shape))
    : null;
  let state: PortState;
  let reason: string;
  if (stateless) {
    state = stateless.state;
    reason = stateless.reason;
  } else {
    const outcome = probes.tcpOutcome(ip, port);
    if (trace) {
      trace.lines.push(traceConnectLine(trace.elapsed(), 'TCP', ip, port, outcome));
    }
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
    const detected = probes.banner(ip, port, options.versionIntensity);
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
  const state = probes.udpState(ip, port, options.probeShape);
  const reason = state === 'open' ? 'udp-response' : state === 'closed' ? 'port-unreach' : 'no-response';
  let service = serviceName(port, 'udp');
  let version: string | undefined;
  if (options.versionScan && state === 'open') {
    const detected = probes.banner(ip, port, options.versionIntensity);
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

  const hidden = all.filter((p) => collapsed.has(p.state));
  const byGroup = new Map<string, NotShownGroup>();
  for (const p of hidden) {
    const key = `${p.state}|${p.protocol}|${p.reason}`;
    const group = byGroup.get(key);
    if (group) group.ports.push(p.port);
    else {
      byGroup.set(key,
        { state: p.state, protocol: p.protocol, reason: p.reason, ports: [p.port] });
    }
  }
  const groups = [...byGroup.values()].sort((a, b) => {
    const byStateCount = (byState.get(b.state) ?? 0) - (byState.get(a.state) ?? 0);
    return byStateCount !== 0 ? byStateCount : b.ports.length - a.ports.length;
  });
  return { ports, notShown: { count: hidden.length, groups } };
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
  hopCache: Map<string, string>, trace?: TraceContext,
): Promise<HostReport | null> {
  const resolved = await probes.resolveTarget(target);
  if (!resolved) return null;
  // Le filtre de `nmap` ne laisse passer que ce qui concerne ses cibles,
  // et une cible n'est connue qu'une fois resolue.
  trace?.targets.add(resolved.ip);

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
    else all.push(tcpResult(options, probes, info.ip, port, trace));
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

  const startedAtMs = performance.now();
  const trace: TraceContext | undefined = options.packetTrace ? {
    targets: new Set<string>(),
    lines: [],
    elapsed: () => (performance.now() - startedAtMs) / 1000,
    connectScan: options.scanType === 'tcp',
  } : undefined;
  const stopWire = trace && probes.observeWire
    ? probes.observeWire((direction, frame) => {
        const line = traceFrameLine(
          direction, trace.elapsed(), frame, trace.targets, trace.connectScan);
        if (line) trace.lines.push(line);
      })
    : undefined;

  for (const target of options.targets) {
    for (const address of enumerateTargets(target)) {
      if (options.excluded && addrSetContains(options.excluded, address)) continue;
      const report = await scanHost(options, probes, address, phases, hopCache, trace)
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

  stopWire?.();

  return {
    startedAt: new Date().toISOString(),
    targetsScanned,
    hostsUp: hosts.filter((h) => h.up).length,
    hosts,
    unresolved,
    phases,
    packetTrace: trace?.lines ?? [],
  };
}

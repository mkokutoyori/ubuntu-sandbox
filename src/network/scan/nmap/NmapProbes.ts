import type { Equipment } from '@/network/equipment/Equipment';
import type { TcpWireOutcome } from '@/network/tcp/types';
import type { ScanProbeShape, StatelessProbeReply } from '@/network/tcp/TcpStack';
import {
  SCAN_PROBE_FLAGS, readStatelessReply,
  type ScanProbeFlags, type StatelessScanKind,
} from './StatelessScans';
import { IP_PROTO_UDP, IPAddress, IPv6Address } from '@/network/core/types';
import { ICMP_UNREACH_PORT } from '@/network/core/IcmpErrors';
import { findHostByAddress } from '@/network/devices/linux/network/HostLookup';
import {
  grabUdpListener, grabUdpBanner,
} from '@/network/devices/linux/commands/net/ServiceBannerGrab';
import { detectServiceFromBanner } from './BannerAnalyzer';
import { serviceFromProcess } from './ProcessServiceMap';
import type { HostProbes, HostState, ResolvedTarget } from './ScanEngine';

/**
 * Ce dont `nmap` a besoin d'une machine pour SONDER, et rien de plus.
 * `nmap` n'est pas une commande Linux — Windows en porte un aussi — donc
 * le moteur est un seul et chaque plateforme remplit ce port avec sa
 * propre pile.
 */
export interface ScanHost {
  readonly device: Equipment | null;
  readFile(path: string): string | null;
  ping(ip: string, timeoutMs: number): Promise<Array<{
    success: boolean; rttMs?: number; ttl?: number;
  }>>;
  tcpOutcome(ip: string, port: number): TcpWireOutcome;
  grabGreeting(ip: string, port: number): string | null;
  sendUdpProbe(
    ip: string, port: number, sourcePort: number,
    options?: { ttl?: number; badChecksum?: boolean; sourceIp?: IPAddress },
  ): boolean;
  /** Un segment hors connexion, et ce qui revient — la lecture est au moteur. */
  scanProbe(
    ip: string, port: number, flags: ScanProbeFlags, shape?: ScanProbeShape,
  ): StatelessProbeReply;
  /**
   * Ce que `arpping()` demande a la machine. Les TROIS issues sont
   * distinctes : `null` veut dire que la cible n'est pas sur ce segment,
   * `{ mac: null }` qu'elle y est et n'a pas repondu, et une adresse
   * qu'elle a repondu.
   */
  linkNeighbour(ip: string): { mac: string | null; rttMs?: number } | null;
  /** Le nom d'une adresse, par la chaine de resolution de la machine. */
  reverseName(ip: string): Promise<string | null>;
  /** L'adresse d'un nom, par la meme chaine — ce que fait `getaddrinfo`. */
  resolveName(name: string): Promise<string | null>;
  /**
   * La marche par duree de vie limitee de la machine, celle que sa propre
   * commande `traceroute` emprunte. `nmap` ne porte pas de seconde
   * implantation : ce qu'il ajoute est le CHOIX de la sonde et la mise en
   * page, pas l'emission.
   */
  tracePath(ip: string): Promise<Array<{ ttl: number; ip?: string; rttMs?: number }>>;
}

const UDP_PROBE_SOURCE_PORT = 51820;

interface LinkLayerResolver {
  isDirectlyConnected(ip: IPAddress): boolean;
  resolveLinkLayerAddress(ip: IPAddress): { toString(): string } | null;
  isDirectlyConnected6(ip: IPv6Address): boolean;
  resolveLinkLayerAddress6(ip: IPv6Address): { toString(): string } | null;
}

function linkLayerResolverOf(device: Equipment | null): LinkLayerResolver | null {
  const candidate = device as unknown as Partial<LinkLayerResolver> | null;
  return candidate && typeof candidate.isDirectlyConnected === 'function'
    && typeof candidate.resolveLinkLayerAddress === 'function'
    ? candidate as LinkLayerResolver : null;
}

/**
 * `Target::directlyConnected()` : la cible est-elle sur un de nos
 * segments ? La question est de ROUTAGE et non d'ARP — une cible du
 * meme segment qui ne repond pas reste directement connectee — d'ou la
 * lecture de `isDirectlyConnected` et non celle du voisin.
 */
export function directlyConnectedOf(device: Equipment | null, ip: string): boolean {
  const resolver = linkLayerResolverOf(device);
  if (!resolver) return false;
  if (ip.includes(':')) {
    let target: IPv6Address;
    try { target = new IPv6Address(ip); } catch { return false; }
    return resolver.isDirectlyConnected6(target);
  }
  const target = IPAddress.tryParse(ip);
  return target !== null && resolver.isDirectlyConnected(target);
}

/**
 * Ce que `arpping()` demande a la machine, ecrit une fois pour les deux
 * plateformes : `nmap` n'est pas une commande Linux, et un voisin se
 * resout de la meme facon sous Windows.
 */
export function linkNeighbourOf(
  device: Equipment | null, ip: string,
): { mac: string | null; rttMs?: number } | null {
  const resolver = linkLayerResolverOf(device);
  if (!resolver) return null;
  // `to.srtt` est alimente par la sonde de decouverte quelle qu'elle
  // soit, ARP comprise : c'est l'aller-retour de CETTE sonde que la
  // ligne d'etat annonce, et non une constante.
  const started = performance.now();
  const measured = (mac: { toString(): string } | null) => ({
    mac: mac ? mac.toString() : null,
    rttMs: mac ? performance.now() - started : undefined,
  });
  if (ip.includes(':')) {
    let target: IPv6Address;
    try { target = new IPv6Address(ip); } catch { return null; }
    if (!resolver.isDirectlyConnected6(target)) return null;
    return measured(resolver.resolveLinkLayerAddress6(target));
  }
  const target = IPAddress.tryParse(ip);
  if (!target || !resolver.isDirectlyConnected(target)) return null;
  return measured(resolver.resolveLinkLayerAddress(target));
}

/**
 * nmap.h: the default IPv4 host discovery is `-PE -PA80 -PS443 -PP`, and
 * the unprivileged form is a TCP connect to 80,443. A RST proves the host
 * is alive exactly as a SYN/ACK does — that is what `-PA` exists for — so
 * `refused` counts as up.
 */
const DISCOVERY_PORTS: readonly number[] = Object.freeze([80, 443]);
const DISCOVERY_TIMEOUT_MS = 1000;

interface Discovery {
  up: boolean;
  latencyMs?: number;
  ttl?: number;
  reason?: string;
  /** Le port de la sonde TCP qui a repondu, quand c'est elle qui a repondu. */
  reasonPort?: number;
}

async function discoverHost(host: ScanHost, ip: string): Promise<Discovery> {
  let echo: Array<{ success: boolean; rttMs?: number; ttl?: number }> = [];
  try {
    echo = await host.ping(ip, DISCOVERY_TIMEOUT_MS);
  } catch {
    echo = [];
  }
  const reply = echo.find((r) => r.success);
  if (reply) {
    return { up: true, latencyMs: reply.rttMs, ttl: reply.ttl, reason: 'echo-reply' };
  }

  for (const port of DISCOVERY_PORTS) {
    const outcome = host.tcpOutcome(ip, port);
    if (outcome === 'open') return { up: true, reason: 'syn-ack', reasonPort: port };
    if (outcome === 'refused') return { up: true, reason: 'reset', reasonPort: port };
  }
  return { up: false };
}

/**
 * The initial TTL is the cheapest real stack fingerprint, and the only one
 * this simulator puts on the wire: a reply arrives with the sender's
 * initial value minus the hops crossed, so rounding up to the next usual
 * initial value names the family. Vendors set 64 (Linux, FortiOS), 128
 * (Windows) and 255 (IOS, VRP).
 */
export function osFromInitialTtl(observed: number): string | undefined {
  if (observed <= 0) return undefined;
  if (observed <= 64) return 'Linux 3.2 - 5.4';
  if (observed <= 128) return 'Microsoft Windows';
  return 'Cisco IOS or Huawei VRP';
}

function isNumericAddress(target: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(target) || target.includes(':');
}

/**
 * scan_engine_raw.cc: an ICMP type 3 code 3 from the target closes a UDP
 * port; codes 0, 1, 2, 9, 10 and 13 filter it. Silence leaves the port
 * open|filtered, and a datagram coming back opens it.
 */
function probeUdpPort(
  host: ScanHost, ip: string, port: number, shape: ScanProbeShape = {},
): 'open' | 'closed' | 'open|filtered' {
  const device = host.device;
  if (!device) return 'open|filtered';

  let verdict: 'open' | 'closed' | 'open|filtered' = 'open|filtered';
  const stop = device.getBus().subscribe('host.icmp.unreachable', (event) => {
    const p = event.payload;
    if (p.deviceId !== device.getId()) return;
    if (p.fromIp !== ip) return;
    if (p.origProtocol !== undefined && p.origProtocol !== IP_PROTO_UDP) return;
    if (p.origDestPort !== undefined && p.origDestPort !== port) return;
    verdict = p.icmpCode === ICMP_UNREACH_PORT ? 'closed' : 'open|filtered';
  });

  try {
    host.sendUdpProbe(ip, port, shape.sourcePort ?? UDP_PROBE_SOURCE_PORT, {
      ttl: shape.ttl,
      badChecksum: shape.badChecksum,
      sourceIp: shape.sourceIp === undefined
        ? undefined : new IPAddress(shape.sourceIp),
    });
  } catch {
    stop();
    return 'open|filtered';
  }
  stop();
  return verdict;
}

/**
 * `-6` choisit la FAMILLE de la resolution : un nom se resout en AAAA, et
 * un hote qui n'en porte pas n'est pas une cible IPv6.
 */
function globalIpv6Of(device: Equipment | null): string | null {
  for (const port of device?.getPorts() ?? []) {
    for (const entry of port.getIPv6Addresses()) {
      if (entry.address.isGlobalUnicast()) {
        return entry.address.toString().split('%')[0];
      }
    }
  }
  return null;
}

export function buildScanProbes(
  host: ScanHost, noDns: boolean, preferIpv6 = false,
): HostProbes {
  const cache = new Map<string, ReturnType<typeof findHostByAddress>>();
  const resolve = (target: string) => {
    if (!cache.has(target)) {
      cache.set(target, findHostByAddress(
        target, { readFile: (p) => host.readFile(p) }, host.device));
    }
    return cache.get(target) ?? null;
  };

  return {
    async resolveTarget(target: string) {
      if (isNumericAddress(target)) return { ip: target };
      const found = resolve(target);
      if (found) {
        if (!preferIpv6) return { ip: found.ip, hostname: noDns ? undefined : target };
        const v6 = globalIpv6Of(found.device);
        if (!v6) return null;
        return { ip: v6, hostname: noDns ? undefined : target };
      }
      // `findHostByAddress` couvre `/etc/hosts` et les noms d'equipement,
      // c'est-a-dire la moitie LOCALE de `getaddrinfo`. Un nom que seul le
      // DNS connait passait donc pour irresolvable ; le resolveur de la
      // machine est interroge quand elle n'a rien su dire.
      if (preferIpv6) return null;
      const viaResolver = await host.resolveName(target);
      return viaResolver ? { ip: viaResolver, hostname: noDns ? undefined : target } : null;
    },
    async hostState(target: ResolvedTarget): Promise<HostState> {
      const alive = await discoverHost(host, target.ip);
      return {
        ip: target.ip,
        hostname: target.hostname,
        up: alive.up,
        latencyMs: alive.latencyMs,
        reason: alive.reason,
        reasonPort: alive.reasonPort,
        replyTtl: alive.ttl,
        osHint: alive.ttl === undefined ? undefined : osFromInitialTtl(alive.ttl),
      };
    },
    async fingerprint(ip: string): Promise<string | undefined> {
      const alive = await discoverHost(host, ip);
      return alive.ttl === undefined ? undefined : osFromInitialTtl(alive.ttl);
    },
    reverseName(ip: string) {
      return host.reverseName(ip);
    },
    directlyConnected(ip: string) {
      return directlyConnectedOf(host.device, ip);
    },
    observeWire(sink) {
      const device = host.device;
      if (!device) return () => {};
      const bus = device.getBus();
      const id = device.getId();
      const offs = [
        bus.subscribe('port.frame.tx-requested', (e) => {
          if (e.payload.deviceId === id) sink('SENT', e.payload.frame);
        }),
        bus.subscribe('port.frame.received', (e) => {
          if (e.payload.deviceId === id) sink('RCVD', e.payload.frame);
        }),
      ];
      return () => { for (const off of offs) off(); };
    },
    tracePath(ip: string) {
      return host.tracePath(ip);
    },
    linkDiscovery(ip: string) {
      const neighbour = host.linkNeighbour(ip);
      if (!neighbour) return null;
      const reason = ip.includes(':') ? 'nd-response' : 'arp-response';
      return neighbour.mac === null
        ? { mac: null, reason: 'no-response' }
        : { mac: neighbour.mac, reason, rttMs: neighbour.rttMs };
    },
    tcpOutcome(ip: string, port: number) {
      return host.tcpOutcome(ip, port);
    },
    statelessOutcome(
      ip: string, port: number, kind: StatelessScanKind, flags?: ScanProbeFlags,
      shape?: ScanProbeShape,
    ) {
      return readStatelessReply(
        kind, host.scanProbe(ip, port, flags ?? SCAN_PROBE_FLAGS[kind], shape));
    },
    udpState(ip: string, port: number, shape?: ScanProbeShape) {
      return probeUdpPort(host, ip, port, shape);
    },
    banner(ip: string, port: number) {
      const greeting = host.grabGreeting(ip, port);
      if (greeting) {
        const detected = detectServiceFromBanner(greeting);
        if (detected) return detected;
      }
      // A UDP service never opens a TCP connection, so its identity still
      // comes from the datagram path rather than from a NULL probe.
      const found = resolve(ip);
      if (!found) return null;
      const datagram = grabUdpBanner(found.device, port);
      if (datagram) {
        const detected = detectServiceFromBanner(datagram);
        if (detected) return detected;
      }
      const proc = grabUdpListener(found.device, port);
      return proc ? { service: serviceFromProcess(proc) ?? proc } : null;
    },
  };
}

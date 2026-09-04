import type { Equipment } from '@/network/equipment/Equipment';
import type { TcpWireOutcome } from '@/network/tcp/types';
import type { StatelessProbeReply } from '@/network/tcp/TcpStack';
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
  sendUdpProbe(ip: string, port: number, sourcePort: number): boolean;
  /** Un segment hors connexion, et ce qui revient — la lecture est au moteur. */
  scanProbe(ip: string, port: number, flags: ScanProbeFlags): StatelessProbeReply;
  /**
   * Ce que `arpping()` demande a la machine. Les TROIS issues sont
   * distinctes : `null` veut dire que la cible n'est pas sur ce segment,
   * `{ mac: null }` qu'elle y est et n'a pas repondu, et une adresse
   * qu'elle a repondu.
   */
  linkNeighbour(ip: string): { mac: string | null } | null;
  /** Le nom d'une adresse, par la chaine de resolution de la machine. */
  reverseName(ip: string): Promise<string | null>;
  /** L'adresse d'un nom, par la meme chaine — ce que fait `getaddrinfo`. */
  resolveName(name: string): Promise<string | null>;
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
 * Ce que `arpping()` demande a la machine, ecrit une fois pour les deux
 * plateformes : `nmap` n'est pas une commande Linux, et un voisin se
 * resout de la meme facon sous Windows.
 */
export function linkNeighbourOf(
  device: Equipment | null, ip: string,
): { mac: string | null } | null {
  const resolver = linkLayerResolverOf(device);
  if (!resolver) return null;
  if (ip.includes(':')) {
    let target: IPv6Address;
    try { target = new IPv6Address(ip); } catch { return null; }
    if (!resolver.isDirectlyConnected6(target)) return null;
    const mac = resolver.resolveLinkLayerAddress6(target);
    return { mac: mac ? mac.toString() : null };
  }
  const target = IPAddress.tryParse(ip);
  if (!target || !resolver.isDirectlyConnected(target)) return null;
  const mac = resolver.resolveLinkLayerAddress(target);
  return { mac: mac ? mac.toString() : null };
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
    if (outcome === 'open') return { up: true, reason: 'syn-ack' };
    if (outcome === 'refused') return { up: true, reason: 'reset' };
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
  host: ScanHost, ip: string, port: number,
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
    host.sendUdpProbe(ip, port, UDP_PROBE_SOURCE_PORT);
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
    linkDiscovery(ip: string) {
      const neighbour = host.linkNeighbour(ip);
      if (!neighbour) return null;
      const reason = ip.includes(':') ? 'nd-response' : 'arp-response';
      return neighbour.mac === null
        ? { mac: null, reason: 'no-response' }
        : { mac: neighbour.mac, reason };
    },
    tcpOutcome(ip: string, port: number) {
      return host.tcpOutcome(ip, port);
    },
    statelessOutcome(ip: string, port: number, kind: StatelessScanKind) {
      return readStatelessReply(
        kind, host.scanProbe(ip, port, SCAN_PROBE_FLAGS[kind]));
    },
    udpState(ip: string, port: number) {
      return probeUdpPort(host, ip, port);
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

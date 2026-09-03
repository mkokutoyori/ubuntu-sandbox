import type { Equipment } from '@/network/equipment/Equipment';
import type { TcpWireOutcome } from '@/network/tcp/types';
import { IP_PROTO_UDP } from '@/network/core/types';
import { ICMP_UNREACH_PORT } from '@/network/core/IcmpErrors';
import {
  findHostByAddress, transitAckAclVerdict,
} from '@/network/devices/linux/network/HostLookup';
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
}

const UDP_PROBE_SOURCE_PORT = 51820;

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
}

async function discoverHost(host: ScanHost, ip: string): Promise<Discovery> {
  let echo: Array<{ success: boolean; rttMs?: number; ttl?: number }> = [];
  try {
    echo = await host.ping(ip, DISCOVERY_TIMEOUT_MS);
  } catch {
    echo = [];
  }
  const reply = echo.find((r) => r.success);
  if (reply) return { up: true, latencyMs: reply.rttMs, ttl: reply.ttl };

  for (const port of DISCOVERY_PORTS) {
    const outcome = host.tcpOutcome(ip, port);
    if (outcome === 'open' || outcome === 'refused') return { up: true };
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

function localSourceAddress(host: ScanHost): string {
  for (const port of host.device?.getPorts() ?? []) {
    const ip = port.getIPAddress();
    if (ip && port.getIsUp()) return ip.toString();
  }
  return '0.0.0.0';
}

export function buildScanProbes(host: ScanHost, noDns: boolean): HostProbes {
  const cache = new Map<string, ReturnType<typeof findHostByAddress>>();
  const resolve = (target: string) => {
    if (!cache.has(target)) {
      cache.set(target, findHostByAddress(
        target, { readFile: (p) => host.readFile(p) }, host.device));
    }
    return cache.get(target) ?? null;
  };

  return {
    resolveTarget(target: string) {
      if (isNumericAddress(target)) return { ip: target };
      const found = resolve(target);
      if (!found) return null;
      return { ip: found.ip, hostname: noDns ? undefined : target };
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
    tcpOutcome(ip: string, port: number) {
      return host.tcpOutcome(ip, port);
    },
    udpState(ip: string, port: number) {
      return probeUdpPort(host, ip, port);
    },
    ackReaches(ip: string, port: number) {
      const found = resolve(ip);
      if (!found || found.poweredOff || found.interfaceDown) return false;
      return transitAckAclVerdict(
        localSourceAddress(host), ip, port, new Date(), host.device) === 'permit';
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

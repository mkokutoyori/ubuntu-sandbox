import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { Equipment } from '../../../../equipment/Equipment';
import { IPAddress, IP_PROTO_UDP } from '../../../../core/types';
import { ICMP_UNREACH_PORT } from '../../../../core/IcmpErrors';
import {
  findHostByAddress, localDeviceOf, transitAckAclVerdict,
} from '../../network/HostLookup';
import {
  grabBanner,
  grabListenerProcess,
  grabUdpListener,
  grabUdpBanner,
} from './ServiceBannerGrab';
import { detectServiceFromBanner } from './nmap/BannerAnalyzer';
import { serviceFromProcess } from './nmap/ProcessServiceMap';
import { parseNmapArgs } from './nmap/NmapOptions';
import {
  scan, type HostProbes, type HostState, type ResolvedTarget,
} from './nmap/ScanEngine';
import { renderNormal, renderGreppable } from './nmap/NmapFormatter';
import { makeArgCompleter } from '../completionHelpers';

export { detectServiceFromBanner };

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

async function discoverHost(ctx: LinuxCommandContext, ip: string): Promise<Discovery> {
  let echo: Awaited<ReturnType<typeof ctx.net.pingSequence>> = [];
  try {
    echo = await ctx.net.pingSequence(new IPAddress(ip), 1, DISCOVERY_TIMEOUT_MS);
  } catch {
    echo = [];
  }
  const reply = echo.find((r) => r.success);
  if (reply) return { up: true, latencyMs: reply.rttMs, ttl: reply.ttl };

  for (const port of DISCOVERY_PORTS) {
    const outcome = ctx.net.tcpConnectOutcome(ip, port);
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
function osFromInitialTtl(observed: number): string | undefined {
  if (observed <= 0) return undefined;
  if (observed <= 64) return 'Linux 3.2 - 5.4';
  if (observed <= 128) return 'Microsoft Windows';
  return 'Cisco IOS or Huawei VRP';
}

function isNumericAddress(target: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(target) || target.includes(':');
}

function buildProbes(ctx: LinuxCommandContext, noDns: boolean): HostProbes {
  const vfs = ctx.executor.vfs;
  const cache = new Map<string, ReturnType<typeof findHostByAddress>>();
  const resolve = (target: string) => {
    if (!cache.has(target)) {
      cache.set(target, findHostByAddress(target, { readFile: (p) => vfs.readFile(p) }, localDeviceOf(ctx)));
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
      const alive = await discoverHost(ctx, target.ip);
      return {
        ip: target.ip,
        hostname: target.hostname,
        up: alive.up,
        latencyMs: alive.latencyMs,
        osHint: alive.ttl === undefined ? undefined : osFromInitialTtl(alive.ttl),
      };
    },
    async fingerprint(ip: string): Promise<string | undefined> {
      const alive = await discoverHost(ctx, ip);
      return alive.ttl === undefined ? undefined : osFromInitialTtl(alive.ttl);
    },
    tcpOutcome(ip: string, port: number) {
      return ctx.net.tcpConnectOutcome(ip, port);
    },
    udpState(ip: string, port: number) {
      return probeUdpPort(ctx, ip, port);
    },
    ackReaches(ip: string, port: number) {
      const found = resolve(ip);
      if (!found || found.poweredOff || found.interfaceDown) return false;
      return transitAckAclVerdict(
        localSourceAddress(ctx), ip, port, new Date(), localDeviceOf(ctx)) === 'permit';
    },
    banner(ip: string, port: number) {
      const found = resolve(ip);
      if (!found) return null;
      const banner = grabBanner(found.device, port) ?? grabUdpBanner(found.device, port);
      if (banner) {
        const detected = detectServiceFromBanner(banner);
        if (detected) return detected;
      }
      const proc = grabListenerProcess(found.device, port) ?? grabUdpListener(found.device, port);
      if (proc) return { service: serviceFromProcess(proc) ?? proc };
      return null;
    },
  };
}

/**
 * scan_engine_raw.cc: an ICMP type 3 code 3 from the target closes a UDP
 * port; codes 0, 1, 2, 9, 10 and 13 filter it. Silence leaves the port
 * open|filtered, and a datagram coming back opens it.
 */
function probeUdpPort(
  ctx: LinuxCommandContext, ip: string, port: number,
): 'open' | 'closed' | 'open|filtered' {
  const device = localDeviceOf(ctx);
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
    ctx.net.sendUdpProbe(new IPAddress(ip), port, UDP_PROBE_SOURCE_PORT);
  } catch {
    stop();
    return 'open|filtered';
  }
  stop();
  return verdict;
}

function localSourceAddress(ctx: LinuxCommandContext): string {
  const device = localDeviceOf(ctx);
  for (const port of device?.getPorts() ?? []) {
    const ip = port.getIPAddress();
    if (ip && port.getIsUp()) return ip.toString();
  }
  return '0.0.0.0';
}

export const nmapCommand: LinuxCommand = {
  name: 'nmap',
  package: 'nmap',
  needsNetworkContext: true,
  complete: makeArgCompleter({
    flags: ['-6', '-A', '-F', '-O', '-P0', '-Pn', '-R', '-T', '-d', '-n',
      '-oA', '-oG', '-oN', '-p', '-p-', '-sP', '-sS', '-sT', '-sU', '-sV',
      '-sA', '-sn', '-v', '-vv', '--open', '--reason', '--top-ports'],
    hostsAtBarePosition: true,
  }),
  usage: 'nmap [-sT|-sS|-sU|-sA] [-sV] [-O] [-A] [-p SPEC] [-F] [--top-ports N] [-sn] [-Pn] [--open] [--reason] [-n] [-oN file] [-oG file] <target...>',
  help: 'Discover hosts and services on a network.',

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    const options = parseNmapArgs(args);
    if (options.targets.length === 0) {
      return 'Nmap 7.94 ( https://nmap.org )\nUsage: nmap [Scan Type(s)] [Options] {target specification}';
    }

    const commandLine = `nmap ${args.join(' ')}`;
    const report = await scan(options, buildProbes(ctx, options.noDns));
    const normal = renderNormal(report, options, commandLine);

    const vfs = ctx.executor.vfs;
    const uid = ctx.executor.userMgr.currentUid;
    const gid = ctx.executor.userMgr.currentGid;
    const cwd = ctx.executor.getCwd();
    if (options.outputNormal) {
      vfs.writeFile(vfs.normalizePath(options.outputNormal, cwd), normal + '\n', uid, gid, 0o022);
    }
    if (options.outputGreppable) {
      vfs.writeFile(vfs.normalizePath(options.outputGreppable, cwd), renderGreppable(report, commandLine) + '\n', uid, gid, 0o022);
    }

    return normal;
  },
};

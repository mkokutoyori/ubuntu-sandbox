import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { Equipment } from '../../../../equipment/Equipment';
import { IPAddress } from '../../../../core/types';
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
import { scan, type HostProbes, type HostState } from './nmap/ScanEngine';
import { renderNormal, renderGreppable } from './nmap/NmapFormatter';
import { makeArgCompleter } from '../completionHelpers';

export { detectServiceFromBanner };

const UDP_PROBE_SOURCE_PORT = 51820;

function osFromDevice(device: Equipment): string | undefined {
  switch (device.getOSType?.()) {
    case 'windows': return 'Microsoft Windows';
    case 'cisco-ios': return 'Cisco IOS';
    case 'huawei-vrp': return 'Huawei VRP';
    case 'linux': return 'Linux 3.2 - 5.4';
    default: return undefined;
  }
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
    hostState(target: string): HostState | null {
      const found = resolve(target);
      if (!found) return null;
      const hostname = !noDns && !isNumericAddress(target) ? target : undefined;
      return {
        ip: found.ip,
        hostname,
        up: !found.poweredOff && !found.interfaceDown,
        poweredOff: found.poweredOff,
        interfaceDown: found.interfaceDown,
        osHint: osFromDevice(found.device),
      };
    },
    tcpOutcome(ip: string, port: number) {
      return ctx.net.tcpConnectOutcome(ip, port);
    },
    udpState(ip: string, port: number) {
      const found = resolve(ip);
      if (!found || found.poweredOff || found.interfaceDown) return 'open|filtered';
      try {
        ctx.net.sendUdpProbe(new IPAddress(ip), port, UDP_PROBE_SOURCE_PORT);
      } catch {
        return 'open|filtered';
      }
      return grabUdpListener(found.device, port) ? 'open' : 'closed';
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

  run(ctx: LinuxCommandContext, args: string[]): string {
    const options = parseNmapArgs(args);
    if (options.targets.length === 0) {
      return 'Nmap 7.94 ( https://nmap.org )\nUsage: nmap [Scan Type(s)] [Options] {target specification}';
    }

    const commandLine = `nmap ${args.join(' ')}`;
    const report = scan(options, buildProbes(ctx, options.noDns));
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

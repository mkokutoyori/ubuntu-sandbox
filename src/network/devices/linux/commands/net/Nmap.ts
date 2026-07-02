import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { Equipment } from '../../../../equipment/Equipment';
import { IPAddress } from '../../../../core/types';
import { findHostByAddress } from '../../network/HostLookup';
import {
  grabBanner,
  grabListenerProcess,
  grabUdpListener,
  grabUdpBanner,
} from './ServiceBannerGrab';
import { detectServiceFromBanner } from './nmap/BannerAnalyzer';
import { parseNmapArgs } from './nmap/NmapOptions';
import { scan, type HostProbes, type HostState } from './nmap/ScanEngine';
import { renderNormal, renderGreppable } from './nmap/NmapFormatter';

export { detectServiceFromBanner };

const UDP_PROBE_SOURCE_PORT = 51820;

function osFromDevice(device: Equipment): string | undefined {
  const name = device.constructor.name;
  if (/Windows/.test(name)) return 'Microsoft Windows';
  if (/Cisco/.test(name)) return 'Cisco IOS';
  if (/Huawei/.test(name)) return 'Huawei VRP';
  if (/Linux|EndHost|Server|PC/.test(name)) return 'Linux 3.2 - 5.4';
  return undefined;
}

function isNumericAddress(target: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(target) || target.includes(':');
}

function buildProbes(ctx: LinuxCommandContext, noDns: boolean): HostProbes {
  const vfs = ctx.executor.vfs;
  const cache = new Map<string, ReturnType<typeof findHostByAddress>>();
  const resolve = (target: string) => {
    if (!cache.has(target)) {
      cache.set(target, findHostByAddress(target, { readFile: (p) => vfs.readFile(p) }));
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
    banner(ip: string, port: number) {
      const found = resolve(ip);
      if (!found) return null;
      const banner = grabBanner(found.device, port) ?? grabUdpBanner(found.device, port);
      if (banner) {
        const detected = detectServiceFromBanner(banner);
        if (detected) return detected;
      }
      const proc = grabListenerProcess(found.device, port) ?? grabUdpListener(found.device, port);
      if (proc === 'sshd') return { service: 'ssh', version: 'OpenSSH (protocol 2.0)' };
      if (proc) return { service: proc };
      return null;
    },
  };
}

export const nmapCommand: LinuxCommand = {
  name: 'nmap',
  needsNetworkContext: true,
  usage: 'nmap [-sT|-sS|-sU] [-sV] [-O] [-A] [-p SPEC] [-F] [--top-ports N] [-sn] [-Pn] [--open] [--reason] [-n] [-oN file] [-oG file] <target...>',
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

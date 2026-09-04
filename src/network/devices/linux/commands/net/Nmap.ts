import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { IPAddress, IPv6Address } from '../../../../core/types';
import { localDeviceOf } from '../../network/HostLookup';
import { detectServiceFromBanner } from '@/network/scan/nmap/BannerAnalyzer';
import { linkNeighbourOf, type ScanHost } from '@/network/scan/nmap/NmapProbes';
import { runNmap } from '@/network/scan/nmap/NmapRun';
import { makeArgCompleter } from '../completionHelpers';

export { detectServiceFromBanner };

function scanHost(ctx: LinuxCommandContext): ScanHost {
  return {
    device: localDeviceOf(ctx),
    readFile: (p) => ctx.executor.vfs.readFile(p),
    ping: (ip, timeoutMs) => (ip.includes(':')
      ? ctx.net.ping6Sequence(new IPv6Address(ip), 1, timeoutMs)
      : ctx.net.pingSequence(new IPAddress(ip), 1, timeoutMs)),
    tcpOutcome: (ip, port) => ctx.net.tcpConnectOutcome(ip, port),
    grabGreeting: (ip, port) => ctx.net.grabServiceBanner(ip, port),
    sendUdpProbe: (ip, port, sourcePort) =>
      ctx.net.sendUdpProbe(new IPAddress(ip), port, sourcePort),
    scanProbe: (ip, port, flags) => ctx.net.getTcpStack().scanProbe(ip, port, flags),
    linkNeighbour: (ip) => linkNeighbourOf(localDeviceOf(ctx), ip),
  };
}

export const nmapCommand: LinuxCommand = {
  name: 'nmap',
  package: 'nmap',
  needsNetworkContext: true,
  complete: makeArgCompleter({
    flags: ['-6', '-A', '-F', '-O', '-P0', '-Pn', '-R', '-T', '-d', '-n',
      '-oA', '-oG', '-oN', '-p', '-p-', '-sP', '-sS', '-sT', '-sU', '-sV',
      '-sA', '-sF', '-sM', '-sN', '-sW', '-sX', '-sn', '-v', '-vv',
      '--disable-arp-ping', '--open', '--reason', '--send-ip', '--top-ports'],
    hostsAtBarePosition: true,
  }),
  usage: 'nmap [-sT|-sS|-sU|-sA|-sF|-sN|-sX|-sM|-sW] [-sV] [-O] [-A] [-p SPEC] [-F] [--top-ports N] [-sn] [-Pn] [--open] [--reason] [-n] [-oN file] [-oG file] <target...>',
  help: 'Discover hosts and services on a network.',

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    const result = await runNmap(scanHost(ctx), args);

    const vfs = ctx.executor.vfs;
    const uid = ctx.executor.userMgr.currentUid;
    const gid = ctx.executor.userMgr.currentGid;
    const cwd = ctx.executor.getCwd();
    if (result.outputNormalPath) {
      vfs.writeFile(vfs.normalizePath(result.outputNormalPath, cwd), result.normal + '\n', uid, gid, 0o022);
    }
    if (result.outputGreppablePath && result.greppable !== null) {
      vfs.writeFile(vfs.normalizePath(result.outputGreppablePath, cwd), result.greppable + '\n', uid, gid, 0o022);
    }

    return result.output;
  },
};

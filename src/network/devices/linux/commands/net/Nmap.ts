import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { IPAddress, IPv6Address } from '../../../../core/types';
import { localDeviceOf } from '../../network/HostLookup';
import { forwardAddressOfAsync, reverseNameOfAsync } from '../../network/ReverseName';
import { detectServiceFromBanner } from '@/network/scan/nmap/BannerAnalyzer';
import { linkNeighbourOf, type ScanHost } from '@/network/scan/nmap/NmapProbes';
import { runNmap } from '@/network/scan/nmap/NmapRun';
import { makeArgCompleter } from '../completionHelpers';

export { detectServiceFromBanner };

function scanHost(ctx: LinuxCommandContext): ScanHost {
  return {
    device: localDeviceOf(ctx),
    readFile: (p) => ctx.executor.vfs.readFile(
      ctx.executor.vfs.normalizePath(p, ctx.executor.getCwd())),
    ping: (ip, timeoutMs) => (ip.includes(':')
      ? ctx.net.ping6Sequence(new IPv6Address(ip), 1, timeoutMs)
      : ctx.net.pingSequence(new IPAddress(ip), 1, timeoutMs)),
    tcpOutcome: (ip, port) => ctx.net.tcpConnectOutcome(ip, port),
    probeService: (ip, port, payload) => ctx.net.probeService(ip, port, payload),
    sendUdpProbe: (ip, port, sourcePort, options) =>
      ctx.net.sendUdpProbe(new IPAddress(ip), port, sourcePort, options),
    scanProbe: (ip, port, flags, shape) =>
      ctx.net.getTcpStack().scanProbe(ip, port, flags, shape),
    linkNeighbour: (ip) => linkNeighbourOf(localDeviceOf(ctx), ip),
    reverseName: (ip) => reverseNameOfAsync(ctx.executor.nss, ip),
    resolveName: (name) => forwardAddressOfAsync(ctx.executor.nss, name),
    tracePath: async (ip) => (await ctx.net.traceroute(new IPAddress(ip)))
      .map((h) => ({ ttl: h.hop, ip: h.ip, rttMs: h.rttMs })),
  };
}

export const nmapCommand: LinuxCommand = {
  name: 'nmap',
  package: 'nmap',
  needsNetworkContext: true,
  complete: makeArgCompleter({
    flags: ['-6', '-A', '-D', '-F', '-O', '-P0', '-Pn', '-R', '-S', '-T', '-d', '-iL', '-iR', '-n',
      '-f', '-ff', '-g', '-oA', '-oG', '-oN', '-oX', '-p', '-p-', '-sP', '-sS', '-sT', '-sU',
      '-sV', '-sA', '-sF', '-sM', '-sN', '-sW', '-sX', '-sn', '-v', '-vv',
      '--badsum', '--data', '--data-length', '--data-string', '--disable-arp-ping',
      '--exclude', '--excludefile', '--mtu',
      '--no-stylesheet', '--open',
      '--packet-trace', '--reason', '--send-ip', '--source-port', '--stylesheet',
      '--top-ports', '--traceroute', '--ttl', '--version-all', '--version-intensity',
      '--version-light', '--webxml'],
    hostsAtBarePosition: true,
  }),
  usage: 'nmap [-iL file] [-iR n] [--exclude spec] [-sT|-sS|-sU|-sA|-sF|-sN|-sX|-sM|-sW] [-sV] [-O] [-A] [-p SPEC] [-F] [--top-ports N] [-sn] [-Pn] [--open] [--reason] [-n] [-oN file] [-oG file] [-oX file] [-oA base] <target...>',
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
    if (result.outputXmlPath && result.xml !== null) {
      vfs.writeFile(vfs.normalizePath(result.outputXmlPath, cwd), result.xml + '\n', uid, gid, 0o022);
    }

    return result.output;
  },
};

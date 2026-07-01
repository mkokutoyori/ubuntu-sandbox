/**
 * `nc` / `ncat` — netcat TCP client (connect-and-probe only; no listen/UDP
 * modes, matching the simulator's synchronous connection model).
 *
 * Extracted from `LinuxCommandExecutor.runNetcatClient` so the command
 * lives in its own file like `route`/`ifconfig`/`nmap`
 * (see `linux_gap.md` §8.4/§9) instead of being embedded in the executor.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { IPAddress } from '../../../../core/types';
import { findHostByAddress, transitTcpAclVerdict } from '../../network/HostLookup';
import { grabBanner as grabRemoteBanner } from './ServiceBannerGrab';

function isIPv6Literal(host: string): boolean {
  return host.includes(':') && /^[0-9a-fA-F:]+(%[a-zA-Z0-9_-]+)?$/.test(host);
}

/** First non-loopback IPv4 configured on this machine, or null. */
function firstConfiguredIp(ctx: LinuxCommandContext): string | null {
  for (const [name, port] of ctx.net.getPorts()) {
    if (name === 'lo') continue;
    const ip = port.getIPAddress();
    if (ip && port.getIsUp()) return ip.toString();
  }
  return null;
}

/** First global-scope IPv6 configured on this machine, or null. */
function firstConfiguredIpv6(ctx: LinuxCommandContext): string | null {
  for (const [name, port] of ctx.net.getPorts()) {
    if (name === 'lo') continue;
    if (!port.getIsUp()) continue;
    const global6 = port.getGlobalIPv6();
    if (global6) return global6.toString();
  }
  return null;
}

function parseNcArgs(args: string[]): {
  positional: string[]; zero: boolean; verbose: boolean; listen: boolean; udp: boolean;
} {
  const positional: string[] = [];
  let zero = false;
  let verbose = false;
  let listen = false;
  let udp = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-z') zero = true;
    else if (a === '-v' || a === '-vv') verbose = true;
    else if (a === '-l') listen = true;
    else if (a === '-u') udp = true;
    else if (a === '-w' && i + 1 < args.length) i++;
    else if (a === '-p' && i + 1 < args.length) i++;
    else if (!a.startsWith('-')) positional.push(a);
    else if (/^-[a-zA-Z]+$/.test(a)) {
      for (const ch of a.slice(1)) {
        if (ch === 'z') zero = true;
        else if (ch === 'v') verbose = true;
        else if (ch === 'l') listen = true;
        else if (ch === 'u') udp = true;
      }
    }
  }
  return { positional, zero, verbose, listen, udp };
}

export const ncCommand: LinuxCommand = {
  name: 'nc',
  aliases: ['ncat'],
  needsNetworkContext: true,
  manSection: 1,
  usage: 'nc [-z] [-v] [-w secs] host port',
  help: 'Arbitrary TCP/UDP connections and probes (connect mode only).',
  options: [
    { flag: '-z', description: 'Zero-I/O mode — probe for listening daemons without sending data.' },
    { flag: '-v', description: 'Verbose — print connection status.' },
    { flag: '-w', description: 'Timeout for connects and final net reads.', takesArg: true, argName: 'secs' },
  ],

  run(ctx: LinuxCommandContext, args: string[]): string {
    const { positional, zero, verbose, listen, udp } = parseNcArgs(args);

    if (listen) return 'nc: listen mode is not supported in this simulator';
    if (udp) return `nc: UDP mode (-u) is not supported in this simulator`;
    if (positional.length < 2) return 'usage: nc [-z] [-v] [-w secs] host port';

    const host = positional[0];
    const portToken = positional[1];
    let port = parseInt(portToken, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      const resolved = ctx.executor.resolveServicePort(portToken);
      if (resolved !== null) port = resolved;
    }
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return `nc: port number invalid: ${portToken}`;
    }

    const targetIsV6 = isIPv6Literal(host);
    const sourceIp = targetIsV6 ? firstConfiguredIpv6(ctx) : firstConfiguredIp(ctx);
    if (!sourceIp || sourceIp === '127.0.0.1') {
      return `nc: connect to ${host} port ${port} (tcp) failed: Network is unreachable`;
    }

    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (isLoopback) {
      const bound = ctx.executor.getSocketTable()?.isPortBound?.(port, 'tcp') ?? false;
      if (bound) {
        if (verbose) return `Connection to ${host} ${port} port [tcp/*] succeeded!`;
        return '';
      }
      if (verbose) return `nc: connect to ${host} port ${port} (tcp) failed: Connection refused`;
      return '';
    }

    const forwarding = ctx.executor.getForwardingTable();
    if ((isLoopback || host === sourceIp) && forwarding) {
      const fwd = forwarding.list().find(f => f.listenPort === port);
      if (fwd && fwd.kind === 'local' && fwd.destHost && fwd.destPort) {
        const originIp = forwarding.getOrigin(port);
        if (originIp) {
          const sshServer = findHostByAddress(originIp);
          const dest = findHostByAddress(fwd.destHost, { readFile: (p) => ctx.executor.vfs.readFile(p) });
          if (!sshServer || !dest) {
            return `nc: connect to ${host} port ${port} (tcp) failed: No route to host`;
          }
          const jumpProbe = (sshServer.device as unknown as {
            tcpProbeSync?: (ip: IPAddress, p: number) => boolean;
          }).tcpProbeSync;
          const ok = jumpProbe
            ? jumpProbe.call(sshServer.device, new IPAddress(dest.ip), fwd.destPort)
            : false;
          if (ok) {
            if (zero && verbose) return `Connection to ${host} ${port} port [tcp/*] succeeded!`;
            if (zero) return '';
            if (verbose) return `Connection to ${host} ${port} port [tcp/*] succeeded!`;
            return '';
          }
          if (verbose) return `nc: connect to ${host} port ${port} (tcp) failed: Connection refused`;
          return '';
        }
      }
    }

    const found = findHostByAddress(host, { readFile: (p) => ctx.executor.vfs.readFile(p) });
    if (!found) {
      return `nc: getaddrinfo for host "${host}" port ${port}: Name or service not known`;
    }
    if (found.poweredOff || found.interfaceDown) {
      return `nc: connect to ${found.ip} port ${port} (tcp) failed: No route to host`;
    }

    if (transitTcpAclVerdict(sourceIp, found.ip, port) === 'deny') {
      if (verbose) return `nc: connect to ${found.ip} port ${port} (tcp) failed: Connection timed out`;
      return '';
    }
    const dstIptables = (found.device as unknown as { executor?: {
      iptables?: { filterPacket: (p: object) => 'accept' | 'drop' | 'reject' };
    } }).executor?.iptables;
    if (dstIptables?.filterPacket) {
      const verdict = dstIptables.filterPacket({
        direction: 'in', protocol: 6, srcIP: sourceIp, dstIP: found.ip,
        srcPort: 50000, dstPort: port, iface: 'eth0',
      });
      if (verdict === 'drop') {
        if (verbose) return `nc: connect to ${found.ip} port ${port} (tcp) failed: Connection timed out`;
        return '';
      }
      if (verdict === 'reject') {
        if (verbose) return `nc: connect to ${found.ip} port ${port} (tcp) failed: Connection refused`;
        return '';
      }
    }
    if (!ctx.executor.hasFreeEphemeralPort()) {
      const msg = `nc: connect to ${found.ip} port ${port} (tcp) failed: Cannot assign requested address`;
      return verbose ? msg : '';
    }
    const ok = ctx.net.tcpProbe(found.ip, port);
    if (!ok) {
      if (verbose) return `nc: connect to ${found.ip} port ${port} (tcp) failed: Connection refused`;
      return '';
    }

    if (zero && verbose) return `Connection to ${host} ${port} port [tcp/*] succeeded!`;
    if (zero) return '';

    const banner = grabRemoteBanner(found.device, port);
    if (banner) {
      const srcPort = ctx.executor.getSocketTable()?.allocateEphemeralPort()
        ?? 49152 + Math.floor(Math.random() * 16000);
      ctx.executor.captureLog.captureTcpHandshake({ ip: sourceIp, port: srcPort }, { ip: found.ip, port });
      const bannerBytes = new TextEncoder().encode(banner);
      ctx.executor.captureLog.captureTcpData({ ip: found.ip, port }, { ip: sourceIp, port: srcPort }, bannerBytes);
      const remoteCap = (found.device as unknown as { executor?: { captureLog?: {
        captureTcpHandshake(src: { ip: string; port: number }, dst: { ip: string; port: number }): void;
        captureTcpData(src: { ip: string; port: number }, dst: { ip: string; port: number }, payload: Uint8Array, seq?: number, ack?: number): void;
      } } }).executor?.captureLog;
      remoteCap?.captureTcpHandshake({ ip: sourceIp, port: srcPort }, { ip: found.ip, port });
      remoteCap?.captureTcpData({ ip: found.ip, port }, { ip: sourceIp, port: srcPort }, bannerBytes);
      const printable = banner.replace(/\r\n$/, '');
      if (verbose) return `Connection to ${host} ${port} port [tcp/*] succeeded!\n${printable}`;
      return printable;
    }

    if (verbose) return `Connection to ${host} ${port} port [tcp/*] succeeded!`;
    return '';
  },
};

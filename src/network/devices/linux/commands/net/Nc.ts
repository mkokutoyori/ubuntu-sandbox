/**
 * `nc` / `ncat` — netcat TCP/UDP client and listener.
 *
 * Listen mode (`-l`, `-l -u`) binds a real socket in the host's
 * `SocketTable` — the same table `ss` and `/proc/net/{tcp,udp}` render
 * from — so a backgrounded `nc -l -p PORT &` shows up consistently across
 * all three views, keyed by the same socket id. It does not accept or
 * exchange data on the connection (the simulator's synchronous execution
 * model has no notion of a blocking accept() loop) — only the bind/listen
 * half, which is what every other observability tool actually inspects.
 *
 * Extracted from `LinuxCommandExecutor.runNetcatClient` so the command
 * lives in its own file like `route`/`ifconfig`/`nmap`
 * (see `linux_gap.md` §8.4/§9) instead of being embedded in the executor.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { IPAddress } from '../../../../core/types';
import { findHostByAddress, transitTcpAclVerdict, localDeviceOf, resolveNatHairpinHost } from '../../network/HostLookup';
import { makeArgCompleter } from '../completionHelpers';

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
  positional: string[]; zero: boolean; verbose: boolean; listen: boolean; udp: boolean; port?: number;
} {
  const positional: string[] = [];
  let zero = false;
  let verbose = false;
  let listen = false;
  let udp = false;
  let port: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-z') zero = true;
    else if (a === '-v' || a === '-vv') verbose = true;
    else if (a === '-l') listen = true;
    else if (a === '-u') udp = true;
    else if (a === '-w' && i + 1 < args.length) i++;
    else if (a === '-p' && i + 1 < args.length) port = parseInt(args[++i], 10);
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
  return { positional, zero, verbose, listen, udp, port };
}

/** `nc -l [-u] [-p PORT] [PORT]` — bind a listening socket and report the
 *  outcome. No accept()/data exchange; see the file-level doc comment. */
function runListen(
  ctx: LinuxCommandContext,
  parsed: ReturnType<typeof parseNcArgs>,
): { output: string; exitCode: number } {
  const { positional, port: pFlagPort, udp, verbose } = parsed;
  const port = pFlagPort ?? (positional.length > 0 ? parseInt(positional[0], 10) : NaN);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { output: 'nc: invalid port for listen', exitCode: 1 };
  }
  const table = ctx.executor.getSocketTable();
  if (!table) return { output: 'nc: no socket table available', exitCode: 1 };
  try {
    table.bind(udp ? 'udp' : 'tcp', '0.0.0.0', port, ctx.executor.currentPid(), 'nc');
  } catch {
    return { output: `nc: Address already in use`, exitCode: 1 };
  }
  if (!udp && !openTcpListener(ctx, port)) {
    table.unbind('tcp', '0.0.0.0', port);
    return { output: `nc: Address already in use`, exitCode: 1 };
  }
  return { output: verbose ? `Listening on 0.0.0.0 ${port}` : '', exitCode: 0 };
}

function openTcpListener(ctx: LinuxCommandContext, port: number): boolean {
  const device = localDeviceOf(ctx) as unknown as {
    getTcpStack?: () => {
      listen(localPort: number, opts: { onAccept: (socket: unknown) => void }): unknown;
    };
  } | null;
  const stack = device?.getTcpStack?.();
  if (!stack) return true;

  try {
    stack.listen(port, { onAccept: () => undefined });
    return true;
  } catch {
    return false;
  }
}

export const ncCommand: LinuxCommand = {
  name: 'nc',
  package: 'netcat-openbsd',
  aliases: ['ncat'],
  needsNetworkContext: true,
  complete: makeArgCompleter({
    flags: ['-l', '-p', '-u', '-v', '-vv', '-w', '-z'],
    hostsAtBarePosition: true,
  }),
  manSection: 1,
  usage: 'nc [-z] [-v] [-w secs] host port',
  help: 'Arbitrary TCP/UDP connections and probes (connect mode only).',
  options: [
    { flag: '-z', description: 'Zero-I/O mode — probe for listening daemons without sending data.' },
    { flag: '-v', description: 'Verbose — print connection status.' },
    { flag: '-w', description: 'Timeout for connects and final net reads.', takesArg: true, argName: 'secs' },
  ],

  run(ctx: LinuxCommandContext, args: string[]): string {
    const parsed = parseNcArgs(args);
    if (parsed.listen) return runListen(ctx, parsed).output;
    const { positional, zero, verbose, udp } = parsed;

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

    if (udp) {
      // Connectionless: there is no handshake to probe, so this just puts a
      // real datagram on the wire — including whatever ICMP error a closed
      // remote port or unreachable host elicits, exactly like real `nc -u`.
      const found = findHostByAddress(host, { readFile: (p) => ctx.executor.vfs.readFile(p) }, localDeviceOf(ctx));
      if (!found) return `nc: getaddrinfo for host "${host}" port ${port}: Name or service not known`;
      if (found.poweredOff || found.interfaceDown) {
        return `nc: connect to ${host} port ${port} (udp) failed: No route to host`;
      }
      const srcPort = ctx.executor.getSocketTable()?.allocateEphemeralPort()
        ?? 49152 + Math.floor(Math.random() * 16000);
      ctx.net.sendUdpProbe(new IPAddress(found.ip), port, srcPort);
      if (verbose) return `Connection to ${host} ${port} port [udp/*] succeeded!`;
      return '';
    }

    const targetIsV6 = isIPv6Literal(host);
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    const sourceIp = isLoopback
      ? (host === '::1' ? '::1' : '127.0.0.1')
      : (targetIsV6 ? firstConfiguredIpv6(ctx) : firstConfiguredIp(ctx));
    if (!sourceIp || (!isLoopback && sourceIp === '127.0.0.1')) {
      return `nc: connect to ${host} port ${port} (tcp) failed: Network is unreachable`;
    }

    const forwarding = ctx.executor.getForwardingTable();
    if ((isLoopback || host === sourceIp) && forwarding) {
      const fwd = forwarding.list().find(f => f.listenPort === port);
      if (fwd && fwd.kind === 'local' && fwd.destHost && fwd.destPort) {
        const originIp = forwarding.getOrigin(port);
        if (originIp) {
          const sshServer = findHostByAddress(originIp, undefined, localDeviceOf(ctx));
          const dest = findHostByAddress(fwd.destHost, { readFile: (p) => ctx.executor.vfs.readFile(p) }, localDeviceOf(ctx));
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

    let found = isLoopback
      ? { ip: sourceIp, device: localDeviceOf(ctx), poweredOff: false, interfaceDown: false }
      : findHostByAddress(host, { readFile: (p) => ctx.executor.vfs.readFile(p) }, localDeviceOf(ctx));
    // `host` may be a NAT hairpin target — the public/static-NAT address of
    // another inside host, unreachable by `findHostByAddress` because it
    // isn't configured on any real interface. Replay the real NAT engine's
    // DNAT+SNAT decision before giving up (see resolveNatHairpinHost's own
    // doc comment) — `effectivePort` becomes whatever port the translation
    // actually resolves to, which can differ from what the user typed.
    let effectivePort = port;
    if (!found) {
      const hairpin = resolveNatHairpinHost(sourceIp, host, port, 'tcp', localDeviceOf(ctx));
      if (hairpin) { found = hairpin; effectivePort = hairpin.port; }
    }
    if (!found) {
      return `nc: getaddrinfo for host "${host}" port ${port}: Name or service not known`;
    }
    if (found.poweredOff || found.interfaceDown) {
      return `nc: connect to ${found.ip} port ${port} (tcp) failed: No route to host`;
    }

    if (transitTcpAclVerdict(sourceIp, found.ip, effectivePort, new Date(), localDeviceOf(ctx)) === 'deny') {
      if (verbose) return `nc: connect to ${found.ip} port ${port} (tcp) failed: Connection timed out`;
      return '';
    }
    if (!ctx.executor.hasFreeEphemeralPort()) {
      const msg = `nc: connect to ${found.ip} port ${port} (tcp) failed: Cannot assign requested address`;
      return verbose ? msg : '';
    }
    const outcome = ctx.net.tcpConnectOutcome(found.ip, effectivePort);
    if (outcome === 'timeout') {
      if (verbose) return `nc: connect to ${found.ip} port ${port} (tcp) failed: Connection timed out`;
      return '';
    }
    if (outcome === 'refused') {
      if (verbose) return `nc: connect to ${found.ip} port ${port} (tcp) failed: Connection refused`;
      return '';
    }

    if (zero && verbose) return `Connection to ${host} ${port} port [tcp/*] succeeded!`;
    if (zero) return '';

    const banner = ctx.net.grabServiceBanner(found.ip, effectivePort);
    if (banner) {
      const printable = banner.replace(/\r\n$/, '');
      if (verbose) return `Connection to ${host} ${port} port [tcp/*] succeeded!\n${printable}`;
      return printable;
    }

    if (verbose) return `Connection to ${host} ${port} port [tcp/*] succeeded!`;
    return '';
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[]) {
    const parsed = parseNcArgs(args);
    if (parsed.listen) return runListen(ctx, parsed);
    return { output: ncCommand.run(ctx, args) as string, exitCode: 0 };
  },
};

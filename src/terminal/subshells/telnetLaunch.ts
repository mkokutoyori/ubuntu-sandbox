/**
 * launchTelnet — the one place a terminal turns `telnet host [port]`
 * into a live session.
 *
 * Linux, Windows and the router CLIs share it so the three of them
 * resolve the target the same way and — the point of the exercise — open
 * exactly one connection: the verdict comes from that connection, never
 * from a throwaway probe before it.
 *
 * What they do NOT share is the wording: each platform's telnet client
 * words the same event its own way, so the transcript comes from a
 * `TelnetDialect` (see `telnetDialect.ts`) rather than being hardcoded to
 * the BSD client for everyone.
 */

import type { Equipment } from '@/network/equipment/Equipment';
import { findHostByAddress } from '@/network/devices/linux/network/HostLookup';
import { isDialFailure } from '@/network/tcp/types';
import { parseDialAddress, type DialAddress } from '@/network/tcp/dial';
import { PortNumber } from '@/network/core/ports/PortNumber';
import { IanaServiceRegistry } from '@/network/core/ports/IanaServiceRegistry';
import {
  TelnetClientSession, type TelnetClientTransport,
} from '@/network/protocols/telnet/TelnetClientSession';
import { TelnetInteractiveSubShell } from './TelnetInteractiveSubShell';
import { BSD_TELNET, type TelnetDialect } from './telnetDialect';

export const TELNET_USAGE = BSD_TELNET.usage;

export interface TelnetLaunchDeps {
  device: Equipment;
  /** Resolver for the local hosts file, when the platform has one. */
  resolverVfs?: { readFile(p: string): string | null };
  emit(text: string, type?: 'error'): void;
  /** How this platform's own client words things. Defaults to BSD telnet. */
  dialect?: TelnetDialect;
}

/**
 * Returns the sub-shell to push, or `null` when the attempt failed — in
 * which case the failure has already been emitted, exactly as the real
 * client words it.
 */
export async function launchTelnet(
  args: readonly string[],
  deps: TelnetLaunchDeps,
): Promise<TelnetInteractiveSubShell | null> {
  const dialect = deps.dialect ?? BSD_TELNET;
  const fail = (lines: string[]): null => {
    // Only the last line is the error itself; `Trying …` is progress and
    // must not be coloured as a failure.
    lines.forEach((l, i) => deps.emit(l, i === lines.length - 1 ? 'error' : undefined));
    return null;
  };

  const positional = args.filter((a) => !a.startsWith('-'));
  const host = positional[0];
  if (!host) { deps.emit(dialect.usage, 'error'); return null; }
  const declaredPort = positional[1]
    ? PortNumber.tryParse(positional[1]) : PortNumber.of(telnetPort());
  if (!declaredPort || declaredPort.value === 0) {
    deps.emit(dialect.usage, 'error');
    return null;
  }
  const port = declaredPort.value;

  const found = findHostByAddress(host, deps.resolverVfs, deps.device);
  if (!found) return fail(dialect.unresolved(host, port));

  const destination = parseDialAddress(found.ip);
  if (!destination) return fail(dialect.unresolved(host, port));

  const device = deps.device as unknown as {
    tcpDial?: (d: DialAddress, p: PortNumber) => Promise<unknown>;
    tcpConnect?: (h: string, p: number) => Promise<TelnetClientTransport | null>;
  };
  const dialed = device.tcpDial
    ? await device.tcpDial.call(deps.device, destination, declaredPort)
    : device.tcpConnect
      ? await device.tcpConnect.call(deps.device, found.ip, port)
      : null;

  if (!dialed || isDialFailure(dialed)) {
    const reason = isDialFailure(dialed) ? dialed.dialFailed : 'refused';
    const wording = reason === 'timeout' ? dialect.timedOut
      : reason === 'unreachable' ? dialect.unreachable
        : dialect.refused;
    return fail(wording(host, found.ip, port));
  }
  const socket = dialed as TelnetClientTransport;

  for (const line of dialect.connected(host, found.ip)) deps.emit(line);
  return new TelnetInteractiveSubShell(new TelnetClientSession(socket), host);
}

function telnetPort(): number {
  return IanaServiceRegistry.standard().resolvePort('telnet', 'tcp') ?? 23;
}

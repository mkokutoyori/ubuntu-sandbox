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
  const port = positional[1] ? parseInt(positional[1], 10) : 23;

  const found = findHostByAddress(host, deps.resolverVfs, deps.device);
  if (!found) return fail(dialect.unresolved(host, port));

  const connect = (deps.device as unknown as {
    tcpConnect?: (h: string, p: number) => Promise<TelnetClientTransport | null>;
  }).tcpConnect;
  const socket = connect ? await connect.call(deps.device, found.ip, port) : null;
  if (!socket) return fail(dialect.refused(host, found.ip, port));

  for (const line of dialect.connected(host, found.ip)) deps.emit(line);
  return new TelnetInteractiveSubShell(new TelnetClientSession(socket), host);
}

/**
 * launchTelnet — the one place a terminal turns `telnet host [port]`
 * into a live session.
 *
 * Linux, Windows and the router CLIs share it so the three of them
 * resolve the target the same way, word their failures the same way, and
 * — the point of the exercise — open exactly one connection: the verdict
 * comes from that connection, never from a throwaway probe before it.
 */

import type { Equipment } from '@/network/equipment/Equipment';
import { findHostByAddress } from '@/network/devices/linux/network/HostLookup';
import {
  TelnetClientSession, type TelnetClientTransport,
} from '@/network/protocols/telnet/TelnetClientSession';
import { TelnetInteractiveSubShell } from './TelnetInteractiveSubShell';

export const TELNET_USAGE = 'usage: telnet host-name [port]';

export interface TelnetLaunchDeps {
  device: Equipment;
  /** Resolver for the local hosts file, when the platform has one. */
  resolverVfs?: { readFile(p: string): string | null };
  emit(text: string, type?: 'error'): void;
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
  const positional = args.filter((a) => !a.startsWith('-'));
  const host = positional[0];
  if (!host) { deps.emit(TELNET_USAGE, 'error'); return null; }
  const port = positional[1] ? parseInt(positional[1], 10) : 23;

  const found = findHostByAddress(host, deps.resolverVfs, deps.device);
  if (!found) {
    deps.emit(`telnet: could not resolve ${host}/${port}: Name or service not known`, 'error');
    return null;
  }

  deps.emit(`Trying ${found.ip}...`);
  const connect = (deps.device as unknown as {
    tcpConnect?: (h: string, p: number) => Promise<TelnetClientTransport | null>;
  }).tcpConnect;
  const socket = connect ? await connect.call(deps.device, found.ip, port) : null;
  if (!socket) {
    deps.emit(`telnet: connect to address ${found.ip}: Connection refused`, 'error');
    return null;
  }

  deps.emit(`Connected to ${host}.`);
  deps.emit("Escape character is '^]'.");
  return new TelnetInteractiveSubShell(new TelnetClientSession(socket), host);
}

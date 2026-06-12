/**
 * oracleNet — client side of Oracle Net (TNS) for the simulated network.
 *
 * Until now, `sqlplus user/pass@X` stripped the connect identifier and
 * always landed on the LOCAL instance, whatever X said — a DB client on
 * one machine could never reach a database on another, and a wrong
 * service name connected anyway. This module gives the terminal tools a
 * real client-side resolution pipeline, mirroring a real sqlplus client:
 *
 *   1. parse the connect identifier — EZConnect (`//host[:port]/service`,
 *      `host:port/service`) or a tnsnames.ora alias read from the LOCAL
 *      device's $ORACLE_HOME/network/admin/tnsnames.ora (editing that
 *      file really changes resolution);
 *   2. locate the target host on the simulated network with the same
 *      lookup the SSH client uses (IP, then hostname);
 *   3. walk the real Oracle error ladder: ORA-12154 (alias unknown),
 *      ORA-12545 (no such host), ORA-12170 (host down), ORA-12541
 *      (no listener / nothing listens on 1521), then delegate to the
 *      target listener's own attemptConnect for ORA-12514 / ORA-12528.
 *
 * The resolved handle is the target's OracleDatabase — a SQL*Plus session
 * can then bind to a REMOTE database across the topology.
 */

import type { Equipment } from '@/network/equipment/Equipment';
import type { HostCapableDevice } from '@/network';
import type { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { ORACLE_CONFIG } from '@/database/oracle/OracleConfig';
import { findEquipmentByIp, findEquipmentByHostname } from '@/shell/hostResolution';

export interface TnsDescriptor {
  host: string;
  port: number;
  service: string;
  /** The alias the descriptor came from, when not EZConnect. */
  alias?: string;
}

export type TnsResolution =
  | { ok: true; db: OracleDatabase; remote: boolean; descriptor: TnsDescriptor }
  | { ok: false; error: string };

/**
 * Parse a connect identifier into host/port/service. EZConnect forms are
 * handled inline; a bare word is looked up in the local tnsnames.ora.
 * Returns null when the alias cannot be resolved (→ ORA-12154).
 */
export function parseConnectIdentifier(
  localDevice: HostCapableDevice,
  identifier: string,
): TnsDescriptor | null {
  const id = identifier.trim();
  // EZConnect: //host[:port]/service  or  host[:port]/service
  const ez = id.replace(/^\/\//, '');
  if (ez.includes('/') || ez.includes(':')) {
    const [addr, service] = splitOnce(ez, '/');
    const [host, portStr] = splitOnce(addr, ':');
    if (!host) return null;
    return {
      host,
      port: portStr ? Number.parseInt(portStr, 10) : ORACLE_CONFIG.PORT,
      service: (service || '').toUpperCase() || ORACLE_CONFIG.SID,
    };
  }
  return lookupTnsAlias(localDevice, id);
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

/**
 * Resolve an alias against the device's real tnsnames.ora — the file the
 * Oracle provisioning writes and the user can edit with vi/nano.
 */
function lookupTnsAlias(localDevice: HostCapableDevice, alias: string): TnsDescriptor | null {
  const content = localDevice.readFileForEditor?.(
    `${ORACLE_CONFIG.HOME}/network/admin/tnsnames.ora`);
  if (!content) return null;
  // Entries look like:  ALIAS =\n (DESCRIPTION = ... (HOST = h)(PORT = p) ... (SERVICE_NAME = s)
  const entryRe = new RegExp(
    `(?:^|\\n)\\s*${escapeRe(alias)}\\s*=`, 'i');
  const m = entryRe.exec(content);
  if (!m) return null;
  // The entry body runs until the next top-of-line `WORD =` or EOF.
  const rest = content.slice(m.index + m[0].length);
  const next = /\n[A-Za-z][\w.$-]*\s*=/.exec(rest);
  const body = next ? rest.slice(0, next.index) : rest;
  const host = /\(\s*HOST\s*=\s*([^)\s]+)\s*\)/i.exec(body)?.[1];
  const port = /\(\s*PORT\s*=\s*(\d+)\s*\)/i.exec(body)?.[1];
  const service = /\(\s*SERVICE_NAME\s*=\s*([^)\s]+)\s*\)/i.exec(body)?.[1]
    ?? /\(\s*SID\s*=\s*([^)\s]+)\s*\)/i.exec(body)?.[1];
  if (!host) return null;
  return {
    host,
    port: port ? Number.parseInt(port, 10) : ORACLE_CONFIG.PORT,
    service: (service ?? ORACLE_CONFIG.SID).toUpperCase(),
    alias: alias.toUpperCase(),
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Is this address one of the local device's own identities? */
function isLocalAddress(localDevice: HostCapableDevice, host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return true;
  const hostname = (localDevice as unknown as { getHostname?: () => string }).getHostname?.();
  if (hostname && hostname.toLowerCase() === h) return true;
  const ports = (localDevice as unknown as {
    ports?: Map<string, { getIPAddress: () => { toString(): string } | null }>;
  }).ports;
  if (ports) {
    for (const p of ports.values()) {
      if (p.getIPAddress?.()?.toString() === host) return true;
    }
  }
  return false;
}

/**
 * Resolve a connect identifier all the way to a target OracleDatabase,
 * walking the client-visible Oracle Net error ladder.
 */
export function resolveOracleConnectTarget(
  localDevice: HostCapableDevice,
  identifier: string,
  /** Injected to avoid a database.ts ⇄ oracleNet import cycle. */
  getDb: (deviceId: string) => OracleDatabase,
): TnsResolution {
  const desc = parseConnectIdentifier(localDevice, identifier);
  if (!desc) {
    return { ok: false, error: 'ORA-12154: TNS:could not resolve the connect identifier specified' };
  }

  let target: Equipment | HostCapableDevice = localDevice;
  let remote = false;
  if (!isLocalAddress(localDevice, desc.host)) {
    const found = findEquipmentByIp(desc.host) ?? findEquipmentByHostname(desc.host);
    if (!found) {
      return { ok: false, error: 'ORA-12545: Connect failed because target host or object does not exist' };
    }
    const isOn = (found as unknown as { getIsPoweredOn?: () => boolean }).getIsPoweredOn?.() ?? true;
    if (!isOn) {
      return { ok: false, error: 'ORA-12170: TNS:Connect timeout occurred' };
    }
    target = found;
    remote = true;
  }

  // Only Linux servers carry an Oracle home in this simulator — anything
  // else simply has nothing listening on the TNS port.
  if (target.getType() !== 'linux-server' && remote) {
    return { ok: false, error: 'ORA-12541: TNS:no listener' };
  }

  const db = getDb(target.getId());
  if (desc.port !== db.instance.listener.port) {
    return { ok: false, error: 'ORA-12541: TNS:no listener' };
  }
  const outcome = db.instance.listener.attemptConnect(desc.service);
  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return { ok: true, db, remote, descriptor: desc };
}

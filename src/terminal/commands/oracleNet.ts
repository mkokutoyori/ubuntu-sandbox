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
import { isPathReachable } from '@/network/devices/linux/network/HostLookup';

export interface TnsDescriptor {
  host: string;
  port: number;
  service: string;
  /** The alias the descriptor came from, when not EZConnect. */
  alias?: string;
  /**
   * A full `(DESCRIPTION=...(ADDRESS_LIST=(ADDRESS=...)(ADDRESS=...))...)`
   * carries more than one address to try in order (TAF's ADDRESS_LIST
   * failover) — `host`/`port` above are always the FIRST address, kept
   * for every caller that only cares about a single target. `resolveOracleConnectTarget`
   * walks the full list when present.
   */
  addressList?: { host: string; port: number }[];
  /** `(FAILOVER=ON)` and/or a `FAILOVER_MODE` clause under CONNECT_DATA. */
  failoverEnabled?: boolean;
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
  // Full TNS descriptor: (DESCRIPTION=(ADDRESS_LIST=...)(CONNECT_DATA=...)),
  // the form ADDRESS_LIST/TAF connect strings use.
  if (id.startsWith('(')) {
    return parseTnsDescription(id);
  }
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

/**
 * Parses the classic Oracle Net `(DESCRIPTION=(...)...)` keyword-value
 * grammar — the nested-parens format used both in tnsnames.ora entries
 * (see `lookupTnsAlias` below, which extracts HOST/PORT/SERVICE_NAME/SID
 * the same textual way) and in a literal connect-string like
 * `sqlplus user/pass@(DESCRIPTION=(FAILOVER=ON)(ADDRESS_LIST=...))`.
 * Only the keys this client acts on are extracted (ADDRESS HOST/PORT in
 * order, CONNECT_DATA SERVICE_NAME/SID, FAILOVER/FAILOVER_MODE presence)
 * — every other real TNS keyword (SDU, RECV_BUF_SIZE, LOAD_BALANCE, …) is
 * silently ignored rather than rejected, matching this module's existing
 * EZConnect parser's own scope.
 */
function parseTnsDescription(text: string): TnsDescriptor | null {
  const addresses: { host: string; port: number }[] = [];
  for (const body of findBalancedGroups(text, 'ADDRESS')) {
    const host = /\(\s*HOST\s*=\s*([^)\s]+)\s*\)/i.exec(body)?.[1];
    const port = /\(\s*PORT\s*=\s*(\d+)\s*\)/i.exec(body)?.[1];
    if (host) addresses.push({ host, port: port ? Number.parseInt(port, 10) : ORACLE_CONFIG.PORT });
  }
  if (addresses.length === 0) return null;

  const connectDataBody = findBalancedGroups(text, 'CONNECT_DATA')[0] ?? text;
  const service = /\(\s*SERVICE_NAME\s*=\s*([^)\s]+)\s*\)/i.exec(connectDataBody)?.[1]
    ?? /\(\s*SID\s*=\s*([^)\s]+)\s*\)/i.exec(connectDataBody)?.[1];

  const failoverEnabled = /\(\s*FAILOVER\s*=\s*ON\s*\)/i.test(text) || /FAILOVER_MODE/i.test(text);

  return {
    host: addresses[0].host,
    port: addresses[0].port,
    service: (service ?? '').toUpperCase() || ORACLE_CONFIG.SID,
    addressList: addresses,
    failoverEnabled,
  };
}

/**
 * Finds every `(KEY=...)` group in `text` at any nesting depth and returns
 * each one's body (the text between the outer parens, `KEY=...` included),
 * using real paren-depth counting instead of regex — a plain
 * `[^)]*`-style regex can't skip past sibling groups like
 * `(ADDRESS=(PROTOCOL=TCP)(HOST=x)(PORT=y))`, since the first inner `)`
 * ends the character class before the next sibling `(...)` is reached.
 */
function findBalancedGroups(text: string, key: string): string[] {
  const results: string[] = [];
  const startRe = new RegExp(`\\(\\s*${key}\\s*=`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(text)) !== null) {
    const start = m.index;
    let depth = 0;
    let i = start;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    results.push(text.slice(start + 1, i - 1));
    startRe.lastIndex = i;
  }
  return results;
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

/** First configured IPv4 of a device, as a dotted string, if any. */
export function primaryIpv4(dev: unknown): string | undefined {
  const ports = (dev as { getPorts?: () => Array<{ getIPAddress: () => { toString(): string } | null }> }).getPorts?.();
  if (!ports) return undefined;
  for (const p of ports) {
    const ip = p.getIPAddress?.();
    if (ip) return ip.toString();
  }
  return undefined;
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

/** Resolve exactly one host/port/service against the topology — the
 *  single-address body `resolveOracleConnectTarget` used to run inline;
 *  factored out so an ADDRESS_LIST can retry it per address. */
function resolveOneAddress(
  localDevice: HostCapableDevice,
  host: string,
  port: number,
  service: string,
  getDb: (deviceId: string) => OracleDatabase,
): { ok: true; db: OracleDatabase; remote: boolean } | { ok: false; error: string } {
  let target: Equipment | HostCapableDevice = localDevice;
  let remote = false;
  if (!isLocalAddress(localDevice, host)) {
    const found = findEquipmentByIp(host) ?? findEquipmentByHostname(host);
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

  // The SYN to the listener crosses the target host's INPUT firewall
  // before any TNS negotiation. A blocked TCP 1521 must therefore look
  // exactly as it does on a real host: a DROP silently swallows the SYN
  // (client times out → ORA-12170), a REJECT actively refuses it
  // (indistinguishable from no listener → ORA-12541). Local bequest
  // connections never traverse the network, so they are exempt.
  if (remote) {
    const dstIP = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : (primaryIpv4(target) ?? host);
    const srcIP = primaryIpv4(localDevice) ?? '0.0.0.0';

    // A cabled path that stops answering (an interface taken down, a
    // cable pulled) must fail the same way a real client's SYN would
    // time out — this is what lets a RAC client actually notice node1
    // disappearing instead of the connect identifier resolving forever.
    if (!isPathReachable(srcIP, dstIP, localDevice)) {
      return { ok: false, error: 'ORA-12170: TNS:Connect timeout occurred' };
    }

    const fwHost = target as unknown as {
      firewallAcceptsInboundTcp?: (srcIP: string, dstIP: string, dstPort: number) => 'accept' | 'drop' | 'reject';
    };
    if (typeof fwHost.firewallAcceptsInboundTcp === 'function') {
      const verdict = fwHost.firewallAcceptsInboundTcp(srcIP, dstIP, port);
      if (verdict === 'drop') {
        return { ok: false, error: 'ORA-12170: TNS:Connect timeout occurred' };
      }
      if (verdict === 'reject') {
        return { ok: false, error: 'ORA-12541: TNS:no listener' };
      }
    }
  }

  const db = getDb(target.getId());
  if (port !== db.instance.listener.port) {
    return { ok: false, error: 'ORA-12541: TNS:no listener' };
  }
  const sourceIp = remote ? (primaryIpv4(localDevice) ?? '0.0.0.0') : '127.0.0.1';
  const outcome = db.instance.listener.attemptConnect(service, sourceIp);
  if (outcome.ok === false) {
    return { ok: false, error: outcome.error };
  }
  return { ok: true, db, remote };
}

/**
 * Resolve a connect identifier all the way to a target OracleDatabase,
 * walking the client-visible Oracle Net error ladder. An ADDRESS_LIST
 * descriptor tries every address in order and returns the first that
 * succeeds — real Oracle Net client failover behaviour — reporting the
 * LAST address's error only if every one of them fails.
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

  const addresses = desc.addressList ?? [{ host: desc.host, port: desc.port }];
  let lastError = 'ORA-12154: TNS:could not resolve the connect identifier specified';
  for (const addr of addresses) {
    const res = resolveOneAddress(localDevice, addr.host, addr.port, desc.service, getDb);
    if (res.ok) return { ok: true, db: res.db, remote: res.remote, descriptor: { ...desc, host: addr.host, port: addr.port } };
    lastError = res.error;
  }
  return { ok: false, error: lastError };
}

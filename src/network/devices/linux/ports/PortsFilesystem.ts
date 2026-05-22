/**
 * PortsFilesystem — keeps the on-disk view of the port subsystem coherent.
 *
 * Two responsibilities, both pure projections of the port model:
 *   - `/etc/services` — the IANA port⇄name database, seeded from
 *     {@link IanaServiceRegistry}. `getent services` reads it back.
 *   - `/proc/net/tcp` & `/proc/net/udp` — the kernel socket tables exposed
 *     as procfs files, *generated on every read* from the live
 *     {@link SocketTable}, so they never go stale as services bind / unbind.
 *
 * Separated from the SocketTable itself (Single Responsibility): the table
 * reasons about sockets, this class reasons about their file representation.
 */

import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { SocketTable, SocketEntry, SocketState } from '../../../core/SocketTable';
import type { IanaServiceRegistry } from '../../../core/ports/IanaServiceRegistry';

/** Canonical filesystem locations the port subsystem maintains. */
export const PORT_PATHS = {
  services: '/etc/services',
  procNetTcp: '/proc/net/tcp',
  procNetUdp: '/proc/net/udp',
  procNetDir: '/proc/net',
} as const;

/** TCP states mapped to the hex codes the kernel writes in `/proc/net/tcp`. */
const PROC_STATE_HEX: Record<SocketState, string> = {
  ESTABLISHED: '01',
  SYN_SENT: '02',
  SYN_RECEIVED: '03',
  FIN_WAIT_1: '04',
  FIN_WAIT_2: '05',
  TIME_WAIT: '06',
  CLOSED: '07',
  CLOSE_WAIT: '08',
  LAST_ACK: '09',
  LISTEN: '0A',
  CLOSING: '0B',
};

export class PortsFilesystem {
  constructor(private readonly vfs: VirtualFileSystem) {}

  /**
   * Seed `/etc/services` from the IANA registry. Idempotent — an existing
   * file (operator edits, a later boot) is never clobbered.
   */
  seedServicesFile(registry: IanaServiceRegistry): void {
    if (!this.vfs.exists(PORT_PATHS.services)) {
      this.vfs.createFileAt(PORT_PATHS.services, registry.render(), 0o644, 0, 0);
    }
  }

  /**
   * Register `/proc/net/tcp` and `/proc/net/udp` as generated files: their
   * content is produced from the socket table on every read.
   */
  registerProcNet(socketTable: SocketTable): void {
    this.vfs.mkdirp(PORT_PATHS.procNetDir, 0o555, 0, 0);
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetTcp, () =>
      renderProcNet(socketTable.getAll().filter((s) => s.protocol === 'tcp')),
    );
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetUdp, () =>
      renderProcNet(socketTable.getAll().filter((s) => s.protocol === 'udp')),
    );
  }
}

// ─── /proc/net rendering ──────────────────────────────────────────────────

/** Render a `/proc/net/{tcp,udp}` table from a list of socket entries. */
function renderProcNet(sockets: SocketEntry[]): string {
  const header =
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when ' +
    'retrnsmt   uid  timeout inode';
  const rows = sockets.map((sock, index) => {
    const local = `${ipToHex(sock.localAddress)}:${portToHex(sock.localPort)}`;
    const remote = `${ipToHex(sock.remoteAddress)}:${portToHex(sock.remotePort)}`;
    const st = PROC_STATE_HEX[sock.state] ?? '07';
    const sl = String(index).padStart(4);
    return (
      `${sl}: ${local} ${remote} ${st} 00000000:00000000 00:00000000 ` +
      `00000000     0        0 ${sock.id} 1 0000000000000000 100 0 0 10 0`
    );
  });
  return [header, ...rows, ''].join('\n');
}

/**
 * Encode a dotted-quad IPv4 address as the little-endian 8-hex-digit string
 * the kernel writes in procfs (e.g. `127.0.0.53` → `3500007F`).
 */
function ipToHex(address: string): string {
  const octets = address.split('.').map((o) => parseInt(o, 10));
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) {
    return '00000000';
  }
  return octets
    .reverse()
    .map((o) => o.toString(16).toUpperCase().padStart(2, '0'))
    .join('');
}

/** Encode a port number as a 4-digit uppercase hex string. */
function portToHex(port: number): string {
  return port.toString(16).toUpperCase().padStart(4, '0');
}

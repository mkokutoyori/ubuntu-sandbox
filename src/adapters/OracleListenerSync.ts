/**
 * OracleListenerSync — keeps the host's real TCP/IP layer in lockstep
 * with the Oracle TNS listener state.
 *
 * On a real Oracle deployment the TNS listener (`tnslsnr`) is a process
 * that binds the database port (1521 by default) and accepts client
 * connections. Before this adapter the simulated listener was a mere
 * boolean flag on `OracleInstance`: starting it published an event but
 * never opened a socket, so `netstat`/`ss` on the host could not see it
 * and no client could ever reach the port through the network stack.
 *
 * This adapter closes that gap as a pure bus subscriber (mirroring
 * `OracleSystemdSync` / `OracleFilesystemSync`): on `oracle.listener.event`
 * it binds — or releases — a genuine listening socket on the underlying
 * device, via the same `getTcpStack().listen()` + `getSocketTable().bind()`
 * surface that every other TCP daemon (sshd, …) uses.
 *
 * The adapter is device-agnostic: it goes through a thin `ListenerHost`
 * capability interface satisfied by any `EndHost` (LinuxServer, …).
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { Equipment } from '@/network/equipment/Equipment';
import type { SocketTable } from '@/network/core/SocketTable';
import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';

/** Default Oracle TNS listener port. */
const DEFAULT_LISTENER_PORT = 1521;
/** Conventional pid reported for the `tnslsnr` process in `netstat -p`. */
const TNSLSNR_PID = 2001;
const TNSLSNR_PROCESS = 'tnslsnr';
const LISTEN_ADDR = '0.0.0.0';

/** Minimal capability surface this adapter needs from the device. */
export interface ListenerHost {
  getTcpStack(): TcpStack;
  getSocketTable(): SocketTable;
}

export interface OracleListenerSyncCtx {
  resolveDevice(deviceId: string): Equipment | null;
}

export class OracleListenerSync {
  private subs: Unsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly ctx: OracleListenerSyncCtx,
  ) {}

  start(): void {
    if (this.subs.length > 0) return;
    this.subs.push(
      this.bus.subscribe('oracle.listener.event', (e) => {
        const host = this.host(e.payload.deviceId);
        if (!host) return;
        const port = parsePort(e.payload.endpoint) ?? DEFAULT_LISTENER_PORT;
        if (e.payload.state === 'running') {
          this.bind(host, port);
        } else {
          this.release(host, port);
        }
      }),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs.length = 0;
  }

  /** Idempotently open the listening socket on the host's TCP stack. */
  private bind(host: ListenerHost, port: number): void {
    const stack = host.getTcpStack();
    const alreadyListening = stack.listListeners().some(
      (l) => l.localPort === port && l.localIp === LISTEN_ADDR,
    );
    if (!alreadyListening) {
      stack.listen(port, { onAccept: (socket) => this.onAccept(socket) }, LISTEN_ADDR);
    }

    const table = host.getSocketTable();
    const bound = table.getAll().some(
      (s) => s.protocol === 'tcp' && s.localPort === port && s.state === 'LISTEN',
    );
    if (!bound) {
      table.bind('tcp', LISTEN_ADDR, port, TNSLSNR_PID, TNSLSNR_PROCESS);
    }
  }

  /** Idempotently release the listening socket. */
  private release(host: ListenerHost, port: number): void {
    host.getTcpStack().closeListener(port, LISTEN_ADDR);
    host.getSocketTable().unbind('tcp', LISTEN_ADDR, port);
  }

  /**
   * Accept handler for inbound TNS connections. The TCP stack has already
   * completed the handshake and produced an established socket, so the port
   * genuinely answers (tnsping / port probes succeed). Bridging the TNS/SQL
   * payload of remote `sqlplus user/pass@host` sessions onto the in-memory
   * OracleDatabase is handled in a later increment; for now the connection
   * is accepted and left open for the client to drive.
   */
  private onAccept(_socket: TcpSocket): void {
    /* no-op: connection accepted; payload bridging is a future increment */
  }

  private host(deviceId: string): ListenerHost | null {
    const dev = this.ctx.resolveDevice(deviceId) as unknown as Partial<ListenerHost> | null;
    return dev
      && typeof dev.getTcpStack === 'function'
      && typeof dev.getSocketTable === 'function'
      ? (dev as ListenerHost)
      : null;
  }
}

/** Extract the PORT from a TNS endpoint descriptor, e.g. `(...(PORT=1521))`. */
function parsePort(endpoint: string): number | null {
  const m = /PORT=(\d+)/i.exec(endpoint ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

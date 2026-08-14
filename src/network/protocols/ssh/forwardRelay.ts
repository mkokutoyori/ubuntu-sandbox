/**
 * The byte relay shared by the three OpenSSH forwarders (`-L`, `-R`, `-D`).
 *
 * A forwarded connection is two ordinary TCP connections back to back: the
 * one the user opened on the listening side, and the one the tunnel's OTHER
 * end opens towards the target on the user's behalf — the server dials for
 * `-L`/`-D`, the client dials for `-R`, exactly as real OpenSSH does.
 *
 * What stood in the three forwarders before opened an exec channel running
 * `nc <host> <port>` and never called `execute()`, so the remote `nc` was
 * not even invoked: the listener accepted connections and dropped every
 * byte. `ISshExecChannel` exposes a one-shot result, not a stream, so that
 * bridge could never have carried traffic (GAP.md §7.3).
 */

import type { TcpStream as TcpConnection } from '@/network/tcp/types';
import type { EndHost } from '@/network/devices/EndHost';

/**
 * The subset of `TcpSocket` a relay needs. `TcpStream` itself is not
 * enough: `TcpStack.connect()` hands back a socket, whose send method is
 * `send()`, and whose `onClose` is mandatory rather than optional.
 */
export interface DialedSocket {
  send(data: string): void;
  onData(handler: (data: string) => void): () => void;
  onClose(handler: (reason: string) => void): () => void;
  close(): void;
}

/** Open the tunnel's far leg. Returns null when there is nothing to dial from. */
export function dialThroughTunnel(
  dialer: EndHost | null,
  host: string,
  port: number,
): DialedSocket | null {
  if (!dialer) return null;
  const stack = (dialer as { getTcpStack?: () => { connect(h: string, p: number): unknown } })
    .getTcpStack;
  if (typeof stack !== 'function') return null;
  const target = dialer.getTcpStack().connect(host, port);
  return (target as unknown as DialedSocket) ?? null;
}

/** Pipe an accepted connection and the dialed one into each other. */
export function pipeSockets(conn: TcpConnection, target: DialedSocket): void {
  conn.onData((data) => target.send(data));
  target.onData((data) => conn.write(data));
  target.onClose(() => conn.close());
  conn.onClose?.(() => target.close());
}

/**
 * Dial and pipe in one step. Returns false — closing the accepted
 * connection — when the far leg cannot be opened, which is what a user
 * sees as a refused forward.
 */
export function relayThroughDialer(
  conn: TcpConnection,
  dialer: EndHost | null,
  host: string,
  port: number,
): boolean {
  const target = dialThroughTunnel(dialer, host, port);
  if (!target) {
    conn.close();
    return false;
  }
  pipeSockets(conn, target);
  return true;
}

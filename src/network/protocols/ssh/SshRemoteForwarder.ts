/**
 * SshRemoteForwarder — OpenSSH `-R remotePort:localHost:localPort` scaffold.
 *
 * Mirror of `SshLocalForwarder`. Opens a listener on the **remote**
 * device (the SSH server end) at `remotePort`; every accepted connection
 * is bridged back through the SSH session to `localHost:localPort` on
 * the client side.
 *
 * For the simulator, the bridge is exposed via an exec channel running
 * `nc <localHost> <localPort>` on the client — pedagogically sufficient
 * to demonstrate that the listener exists on the remote and traffic is
 * carried over the SSH session.
 *
 * Reference: SSH-IMPLEMENTATION-ANALYSIS.md §5 P6.
 */

import type { TcpStream as TcpConnection } from '@/network/core/TcpConnection';
import type { EndHost } from '@/network/devices/EndHost';
import type { SshSession } from './session/SshSession';
import { isOk } from './Result';

export interface RemoteForwardSpec {
  /** Port opened on the remote (SSH server) device. */
  readonly remotePort: number;
  /** Host the client resolves the forwarded connection to. */
  readonly localHost: string;
  /** Port on the client side of the tunnel. */
  readonly localPort: number;
  /** Descriptive — the SSH server's hostname/IP, for logging. */
  readonly sshHost: string;
}

export class SshRemoteForwarder {
  private registered = false;

  constructor(
    private readonly remoteDevice: EndHost,
    private readonly session: SshSession | null,
    private readonly spec: RemoteForwardSpec,
  ) {}

  getSpec(): RemoteForwardSpec {
    return this.spec;
  }

  /** Idempotent — registering twice is a no-op. */
  register(): void {
    if (this.registered) return;
    this.remoteDevice.listenTcp(this.spec.remotePort, (conn) =>
      this.handleAccept(conn),
    );
    this.registered = true;
  }

  /**
   * Drop the remote-side listener. Existing in-flight tunnels keep
   * running until they close on their own (parity with OpenSSH).
   */
  dispose(): void {
    if (!this.registered) return;
    const listeners = (this.remoteDevice as unknown as {
      tcpListeners: Map<number, unknown>;
    }).tcpListeners;
    listeners.delete(this.spec.remotePort);
    this.registered = false;
  }

  // ─── private ────────────────────────────────────────────────────

  private handleAccept(conn: TcpConnection): void {
    if (!this.session) {
      conn.close();
      return;
    }
    // The pedagogical stub: launch `nc` on the CLIENT (which is the
    // process the SSH session can reach via the same channel API the
    // local forwarder uses).
    const channelResult = this.session.openExecChannel(
      `nc ${this.spec.localHost} ${this.spec.localPort}`,
    );
    if (!isOk(channelResult)) {
      conn.close();
      return;
    }
    const channel = channelResult.value;
    conn.onData((data) => channel.write(data));
    channel.onData((data) => conn.write(data));
    conn.onClose?.(() => channel.close());
  }
}

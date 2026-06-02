/**
 * SshLocalForwarder — OpenSSH `-L localPort:remoteHost:remotePort` scaffold.
 *
 * Lifecycle:
 *   const fwd = new SshLocalForwarder(localDevice, session, spec);
 *   fwd.register();   // listens on `localPort` on localDevice
 *   fwd.dispose();    // tears the listener down
 *
 * Wire semantics (simulator):
 *   On accept, the forwarder asks the SSH server to relay the connection
 *   to `<spec.remoteHost>:<spec.remotePort>`. The current implementation
 *   opens an exec channel running `nc <host> <port>` and bridges the
 *   bytes both ways. Real OpenSSH negotiates a `direct-tcpip` channel —
 *   the pedagogical surface (listener visible in `ss -tln`, traffic
 *   carried over the same SSH session) is what tutorials care about.
 *
 * Reference: SSH-IMPLEMENTATION-ANALYSIS.md §5 P6.
 */

import type { TcpStream as TcpConnection } from '@/network/core/TcpConnection';
import type { EndHost } from '@/network/devices/EndHost';
import type { SshSession } from './session/SshSession';
import { isOk } from './Result';

export interface LocalForwardSpec {
  /** Port opened on the local device the user is ssh-ing from. */
  readonly localPort: number;
  /** Host the SSH server resolves on the user's behalf. */
  readonly remoteHost: string;
  /** Port at the remote host. */
  readonly remotePort: number;
  /** The SSH server hostname (purely descriptive — for logging). */
  readonly sshHost: string;
}

export class SshLocalForwarder {
  private registered = false;
  private readonly listenerKey: number;

  constructor(
    private readonly localDevice: EndHost,
    private readonly session: SshSession | null,
    private readonly spec: LocalForwardSpec,
  ) {
    this.listenerKey = spec.localPort;
  }

  getSpec(): LocalForwardSpec {
    return this.spec;
  }

  /** Idempotent — registering twice is a no-op. */
  register(): void {
    if (this.registered) return;
    this.localDevice.getTcpStack().listen(this.spec.localPort, {
      onAccept: (socket) => this.handleAccept(socket),
    });
    this.registered = true;
  }

  /**
   * Drop the local listener. Existing in-flight tunnels are NOT aborted
   * — that mirrors OpenSSH: only new connections are refused.
   */
  dispose(): void {
    if (!this.registered) return;
    this.localDevice.getTcpStack().closeListener(this.spec.localPort);
    this.registered = false;
  }

  // ─── private ────────────────────────────────────────────────────

  private handleAccept(conn: TcpConnection): void {
    if (!this.session) {
      // Pre-registered forwarder, no SSH yet: refuse cleanly.
      conn.close();
      return;
    }
    // Bridge through an exec channel running `nc remoteHost remotePort`.
    // The simulator's `nc` is a thin stub but the channel events make
    // the tunnel observable via `last`, `auth.log`, and the syslogger.
    const channelResult = this.session.openExecChannel(
      `nc ${this.spec.remoteHost} ${this.spec.remotePort}`,
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

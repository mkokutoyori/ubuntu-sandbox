import { forwardBindIp, forwardFailureOf, type ForwardHost, type ForwardListenOptions, type ForwardOpening } from './ForwardOpening';
import type { TcpStream as TcpConnection } from '@/network/tcp/types';
import { joinWhenReady, type TunnelOpener } from './forwardRelay';

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
    private readonly localDevice: ForwardHost,
    private readonly tunnel: TunnelOpener | null,
    private readonly spec: LocalForwardSpec,
    private readonly listenOptions: ForwardListenOptions = {},
  ) {
    this.listenerKey = spec.localPort;
  }

  getSpec(): LocalForwardSpec {
    return this.spec;
  }

  register(ownerUid?: number): ForwardOpening {
    if (this.registered) return 'opened';
    try {
      this.localDevice.getTcpStack().listen(this.spec.localPort, {
        onAccept: (socket) => this.handleAccept(socket as unknown as TcpConnection),
        ownerUid,
        identity: this.listenOptions.identity,
      }, forwardBindIp(this.listenOptions.bindAddress));
    } catch (error) {
      return forwardFailureOf(error);
    }
    this.registered = true;
    return 'opened';
  }

  /**
   * Drop the local listener. Existing in-flight tunnels are NOT aborted
   * — that mirrors OpenSSH: only new connections are refused.
   */
  dispose(): void {
    if (!this.registered) return;
    this.localDevice.getTcpStack().closeListener(this.spec.localPort, forwardBindIp(this.listenOptions.bindAddress));
    this.registered = false;
  }

  private handleAccept(conn: TcpConnection): void {
    if (this.tunnel === null) {
      conn.close();
      return;
    }
    joinWhenReady(conn, this.tunnel(this.spec.remoteHost, this.spec.remotePort));
  }
}

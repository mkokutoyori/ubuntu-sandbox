import { PortNumber } from '@/network/core/ports/PortNumber';
import { dialStream, parseDialAddress } from '@/network/tcp/dial';
import { isDialFailure } from '@/network/tcp/types';
import type { ForwardedConnection, SshSession } from './session/SshSession';
import type { ForwardHost } from './ForwardOpening';
import { SSH_OPEN_CONNECT_FAILED } from './transport/SshMessageNumbers';
import { joinWhenReady } from './forwardRelay';
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
  readonly bindAddress?: string;
}

const LOOPBACK = '127.0.0.1';
const DEFAULT_BIND = 'localhost';

const DIAL_FAILURES = {
  refused: 'Connection refused',
  timeout: 'Connection timed out',
  unreachable: 'No route to host',
} as const;

export class SshRemoteForwarder {
  private boundPort: number | null = null;

  constructor(
    private readonly session: SshSession | null,
    private readonly localDevice: ForwardHost,
    private readonly spec: RemoteForwardSpec,
    private readonly resolveHost: (name: string) => string | null = () => null,
  ) {}

  getSpec(): RemoteForwardSpec {
    return this.spec;
  }

  getBoundPort(): number | null {
    return this.boundPort;
  }

  async register(): Promise<boolean> {
    return new Promise((resolve) => this.registerWith(resolve));
  }

  registerNow(): boolean | null {
    let outcome: boolean | null = null;
    this.registerWith((accepted) => { outcome = accepted; });
    return outcome;
  }

  private registerWith(done: (accepted: boolean) => void): void {
    if (this.boundPort !== null) {
      done(true);
      return;
    }
    if (this.session === null) {
      done(false);
      return;
    }
    this.session.requestRemoteForwardNow(
      this.spec.bindAddress ?? DEFAULT_BIND, this.spec.remotePort, (connection) => { void this.serve(connection); },
      (bound) => {
        if (!isOk(bound)) {
          done(false);
          return;
        }
        this.boundPort = bound.value;
        done(true);
      });
  }

  dispose(): void {
    if (this.boundPort === null) return;
    const port = this.boundPort;
    this.boundPort = null;
    void this.session?.cancelRemoteForward(this.spec.bindAddress ?? DEFAULT_BIND, port);
  }

  private async serve(connection: ForwardedConnection): Promise<void> {
    const host = this.spec.localHost === 'localhost' ? LOOPBACK : this.spec.localHost;
    const address = parseDialAddress(host) ?? parseDialAddress(this.resolveHost(host) ?? '');
    if (address === null || !PortNumber.isValid(this.spec.localPort)) {
      connection.reject(SSH_OPEN_CONNECT_FAILED, 'Name or service not known');
      return;
    }
    const dialed = await dialStream(this.localDevice.getTcpStack(), address, PortNumber.of(this.spec.localPort));
    if (isDialFailure(dialed)) {
      connection.reject(SSH_OPEN_CONNECT_FAILED, DIAL_FAILURES[dialed.dialFailed]);
      return;
    }
    joinWhenReady(dialed, Promise.resolve(connection.accept()));
  }
}

import type { TcpAcceptHandler, TcpStack } from '../../../tcp/TcpStack';

export interface RemoteAccessService {
  wanted(): boolean;
  port(): number;
  onAccept: TcpAcceptHandler;
}

export interface RemoteAccessListenersDeps {
  stack(): Pick<TcpStack, 'listen' | 'closeListener' | 'listListeners'>;
  ssh: RemoteAccessService;
  telnet: RemoteAccessService;
}

export class RemoteAccessListeners {
  private sshBound: number | null = null;
  private telnetBound: number | null = null;

  constructor(private readonly deps: RemoteAccessListenersDeps) {}

  sync(): void {
    this.sshBound = this.syncOne(this.sshBound, this.deps.ssh);
    this.telnetBound = this.syncOne(this.telnetBound, this.deps.telnet);
  }

  private syncOne(bound: number | null, service: RemoteAccessService): number | null {
    const stack = this.deps.stack();
    const live = bound !== null && stack.listListeners().some((l) => l.localPort === bound);
    const wanted = service.wanted();
    const port = service.port();
    if (live && wanted && bound === port) return bound;
    if (live) stack.closeListener(bound!);
    if (!wanted) return null;
    stack.listen(port, { onAccept: service.onAccept });
    return port;
  }
}

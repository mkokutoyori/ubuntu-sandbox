import type { TcpStack, TcpSocket } from '../../tcp/TcpStack';
import type { ListenerIdentity } from '../../tcp/ListenerSocketSink';
import type { PortProxyRule } from './PortProxyRule';
import type { WindowsEndpoint } from './WindowsServicePortProjection';

export class PortProxyEndpoint implements WindowsEndpoint {
  private readonly listening = new Map<string, PortProxyRule>();

  constructor(
    private readonly rules: () => readonly PortProxyRule[],
    private readonly tcpStack: TcpStack,
  ) {}

  open(identity: ListenerIdentity): void {
    const wanted = new Map(this.rules().map((rule) => [rule.key, rule]));
    for (const [key, rule] of [...this.listening]) {
      if (wanted.get(key) === rule) continue;
      this.stopListening(key, rule);
    }
    for (const [key, rule] of wanted) {
      if (this.listening.has(key)) continue;
      if (this.tryListen(rule, identity)) this.listening.set(key, rule);
    }
  }

  close(): void {
    for (const [key, rule] of [...this.listening]) this.stopListening(key, rule);
  }

  private stopListening(key: string, rule: PortProxyRule): void {
    this.tcpStack.closeListener(rule.listenPort, rule.listenAddress);
    this.listening.delete(key);
  }

  private tryListen(rule: PortProxyRule, identity: ListenerIdentity): boolean {
    try {
      this.tcpStack.listen(
        rule.listenPort,
        { onAccept: (accepted) => this.relay(rule, accepted, identity), identity },
        rule.listenAddress,
      );
      return true;
    } catch {
      return false;
    }
  }

  private relay(rule: PortProxyRule, accepted: TcpSocket, identity: ListenerIdentity): void {
    const upstream = this.tcpStack.connect(rule.connectAddress, rule.connectPort, {
      onData: (data) => accepted.send(data),
      onClose: () => accepted.close(),
    });
    if (!upstream) {
      accepted.close();
      return;
    }
    if (identity.pid !== undefined) this.tcpStack.setSocketOwner(upstream, identity.pid, identity.service);
    accepted.onData((data) => upstream.send(data));
    accepted.onClose(() => upstream.close());
  }
}

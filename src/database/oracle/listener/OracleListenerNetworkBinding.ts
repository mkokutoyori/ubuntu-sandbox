import type { ListenerControl } from './ListenerControl';

interface TcpStackLike {
  listen(port: number, opts: { onAccept: (socket: TcpSocketLike) => void; localIp?: string }): unknown;
  closeListener(port: number, localIp?: string): void;
}

interface TcpSocketLike {
  readonly remoteIp: string;
  close(): void;
}

interface SocketTableLike {
  bind(protocol: 'tcp', localAddress: string, localPort: number, pid?: number, processName?: string, banner?: string): unknown;
  unbind(protocol: 'tcp', localAddress: string, localPort: number): boolean;
  getBannerForPort(protocol: 'tcp', port: number): string | null;
}

interface HostLike {
  getTcpStack(): TcpStackLike;
  readonly socketTable?: SocketTableLike;
  readonly id?: string;
}

export interface OracleListenerNetworkBindingConfig {
  readonly host: HostLike;
  readonly listener: ListenerControl;
  readonly tnsBanner?: string;
  readonly listenerPid?: number;
}

const DEFAULT_TNS_BANNER = '(CONNECT_DATA=(SERVICE_NAME=ORCL))\r\n';
const TNSLSNR_PROCESS = 'tnslsnr';
const DEFAULT_LISTENER_PID = 2001;
const LISTEN_ADDRESSES: readonly string[] = ['0.0.0.0'];

export class OracleListenerNetworkBinding {
  private readonly host: HostLike;
  private readonly listener: ListenerControl;
  private readonly banner: string;
  private readonly pid: number;
  private attached = false;
  private boundPort: number | null = null;

  constructor(cfg: OracleListenerNetworkBindingConfig) {
    this.host = cfg.host;
    this.listener = cfg.listener;
    this.banner = cfg.tnsBanner ?? DEFAULT_TNS_BANNER;
    this.pid = cfg.listenerPid ?? DEFAULT_LISTENER_PID;
  }

  isAttached(): boolean { return this.attached; }
  getBoundPort(): number | null { return this.boundPort; }

  attach(): void {
    if (this.attached) return;
    if (!this.listener.running) {
      throw new Error('Cannot attach network binding: listener is not running');
    }
    const port = this.listener.port;
    const stack = this.host.getTcpStack();
    stack.listen(port, {
      onAccept: (socket) => {
        this.listener.recordScanAttempt(socket.remoteIp, 'syn-probe');
        socket.close();
      },
    });
    this.replaceSocketBanner(port);
    this.boundPort = port;
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    const stack = this.host.getTcpStack();
    for (const addr of LISTEN_ADDRESSES) {
      try { stack.closeListener(this.boundPort!, addr); } catch { /* idempotent */ }
    }
    this.restoreSocketBanner(this.boundPort!);
    this.boundPort = null;
    this.attached = false;
  }

  private replaceSocketBanner(port: number): void {
    const st = this.host.socketTable;
    if (!st) return;
    st.unbind('tcp', '0.0.0.0', port);
    st.unbind('tcp', '::', port);
    const advertised = this.listener.isNoBannerMode() ? '' : this.banner;
    st.bind('tcp', '0.0.0.0', port, this.pid, TNSLSNR_PROCESS, advertised);
    st.bind('tcp', '::', port, this.pid, TNSLSNR_PROCESS, advertised);
  }

  private restoreSocketBanner(port: number): void {
    const st = this.host.socketTable;
    if (!st) return;
    st.unbind('tcp', '0.0.0.0', port);
    st.unbind('tcp', '::', port);
    st.bind('tcp', '0.0.0.0', port, this.pid, TNSLSNR_PROCESS, this.banner);
    st.bind('tcp', '::', port, this.pid, TNSLSNR_PROCESS, this.banner);
  }
}

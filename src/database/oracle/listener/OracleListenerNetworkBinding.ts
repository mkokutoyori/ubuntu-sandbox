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
/**
 * Les deux familles, comme sshd depuis §P2b : la table des sockets
 * annonçait `:::1521` sans écoute propre, si bien qu'un client IPv6
 * voyait un port ouvert que rien ne servait.
 */
const LISTEN_ADDRESSES: readonly string[] = ['0.0.0.0', '::'];

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
    // Reprise du port au démarrage de la base : `LinuxMachine` ouvre déjà
    // une écoute TNS à l'amorçage (§P2c), celle que `dbstart` aurait
    // posée. Sans cette fermeture, `listen()` lèverait EADDRINUSE et la
    // base démarrerait sans jamais enregistrer ses sondes.
    const advertised = this.listener.isNoBannerMode() ? '' : this.banner;
    const identity = { pid: this.pid, processName: TNSLSNR_PROCESS, banner: advertised };
    for (const addr of LISTEN_ADDRESSES) {
      try { stack.closeListener(port, addr); } catch { /* rien à reprendre */ }
      stack.listen(port, {
        onAccept: (socket) => {
          this.listener.recordScanAttempt(socket.remoteIp, 'syn-probe');
          socket.close();
        },
        identity,
      }, addr);
    }
    this.boundPort = port;
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    const stack = this.host.getTcpStack();
    // `closeListener()` retire aussi la ligne de `ss` : depuis §P1 c'est
    // l'écoute qui l'a posée. `lsnrctl stop` ferme donc le port pour de
    // bon — plus de doublon manuel à défaire à côté, et plus d'entrée
    // décorative laissée derrière (§P2c).
    for (const addr of LISTEN_ADDRESSES) {
      try { stack.closeListener(this.boundPort!, addr); } catch { /* idempotent */ }
    }
    this.boundPort = null;
    this.attached = false;
  }
}

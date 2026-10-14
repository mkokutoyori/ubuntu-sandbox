import type { TcpListener, TcpSocket, TcpStack } from '@/network/tcp/TcpStack';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import { TlsServerChannel } from '@/network/tls/TlsServerChannel';
import {
  NKE_ALPN, NKE_EXPORTER_LABEL, NKE_MAX_MESSAGE_LENGTH, aeadKeyLength, buildServerResponse, decodeRecords, endOfMessage,
  exporterContext,
} from './NtsKeRecords';
import type { NtsServerKeys } from './NtsServerKeys';

export interface NtsKeServerSettings {
  readonly tlsConfig: () => TlsServerConfig;
  readonly keys: () => NtsServerKeys;
  readonly ntpPort: () => number;
  readonly ntpServer: () => string | null;
  readonly maxConnections: () => number;
  readonly onAccepted: () => void;
  readonly onDropped: () => void;
}

export class NtsKeServer {
  private listener: TcpListener | null = null;
  private active = 0;

  constructor(private readonly tcp: TcpStack, private readonly port: number, private readonly settings: NtsKeServerSettings) {}

  start(identity?: ListenerIdentity): void {
    this.listener = this.tcp.listen(this.port, { onAccept: (socket) => this.accept(socket), identity });
  }

  stop(): void {
    if (this.listener === null) return;
    this.tcp.closeListener(this.port);
    this.listener = null;
  }

  isRunning(): boolean { return this.listener !== null; }

  private accept(socket: TcpSocket): void {
    if (this.active >= this.settings.maxConnections()) {
      this.settings.onDropped();
      socket.close();
      return;
    }
    this.active++;
    this.settings.onAccepted();
    const config = this.settings.tlsConfig();
    const tls = new TlsServerSession({ ...config, protocols: ['1.3'], alpnProtocols: [NKE_ALPN] });
    let buffer = new Uint8Array(0);
    let finished = false;
    const done = (): void => {
      if (finished) return;
      finished = true;
      this.active--;
    };
    const channel: TlsServerChannel = new TlsServerChannel(socket, tls, {
      onData: (plaintext) => {
        if (finished) return;
        if (tls.negotiatedAlpnProtocol !== NKE_ALPN) { done(); channel.close(); return; }
        const joined = new Uint8Array(buffer.length + plaintext.length);
        joined.set(buffer);
        joined.set(plaintext, buffer.length);
        buffer = joined;
        if (buffer.length > NKE_MAX_MESSAGE_LENGTH) { done(); this.settings.onDropped(); channel.close(); return; }
        const records = decodeRecords(buffer);
        if (records === null || !endOfMessage(records)) return;
        const keys = this.settings.keys();
        const response = buildServerResponse(records, {
          ntpPort: this.settings.ntpPort(),
          ntpServer: this.settings.ntpServer(),
          deriveKeys: (aead) => {
            const length = aeadKeyLength(aead);
            const c2s = tls.exportKeyingMaterial(NKE_EXPORTER_LABEL, exporterContext(aead, 'c2s'), length);
            const s2c = tls.exportKeyingMaterial(NKE_EXPORTER_LABEL, exporterContext(aead, 's2c'), length);
            return c2s === null || s2c === null ? null : { c2s, s2c };
          },
          makeCookie: (aead, c2s, s2c) => keys.generateCookie({ aead, c2s, s2c }),
        });
        channel.write(response);
        done();
        channel.close();
      },
    });
    socket.onClose(() => done());
  }
}

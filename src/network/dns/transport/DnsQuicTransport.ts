import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { DnsMessageHandler } from '@/network/dns/transport/DnsUdpTransport';
import { deriveSessionKey, encryptBytes, decryptBytes } from '@/network/dns/transport/SimulatedTls';

export const DOQ_PORT = 853;
export const DOQ_ALPN = 'doq';

const QUIC_VERSION = 1;
const STREAM_STRIDE = 4;

interface QuicClientDatagram {
  readonly quic: typeof QUIC_VERSION;
  readonly dcid: string;
  readonly alpn: string;
  readonly clientRandom: string;
  readonly streamId: number;
  readonly ciphertext: readonly number[];
}

interface QuicServerDatagram {
  readonly quic: typeof QUIC_VERSION;
  readonly dcid: string;
  readonly streamId: number;
  readonly ciphertext: readonly number[];
}

function isQuicClientDatagram(payload: unknown): payload is QuicClientDatagram {
  const dgram = payload as QuicClientDatagram;
  return dgram?.quic === QUIC_VERSION
    && typeof dgram.dcid === 'string'
    && typeof dgram.clientRandom === 'string'
    && typeof dgram.streamId === 'number'
    && Array.isArray(dgram.ciphertext);
}

function isQuicServerDatagram(payload: unknown): payload is QuicServerDatagram {
  const dgram = payload as QuicServerDatagram;
  return dgram?.quic === QUIC_VERSION
    && typeof dgram.dcid === 'string'
    && typeof dgram.streamId === 'number'
    && Array.isArray(dgram.ciphertext);
}

function sessionKeyFor(clientRandom: string, dcid: string): string {
  return deriveSessionKey(clientRandom, dcid);
}

export interface DoqOptions {
  readonly port?: number;
  readonly alpn?: string;
  readonly timeoutMs?: number;
}

export function bindDnsQuicServer(host: EndHost, handler: DnsMessageHandler, options: DoqOptions = {}): void {
  const port = options.port ?? DOQ_PORT;
  const alpn = options.alpn ?? DOQ_ALPN;
  host.udpBind(port, ({ sourceIP, udp }) => {
    if (!isQuicClientDatagram(udp.payload) || udp.payload.alpn !== alpn) return;
    const dgram = udp.payload;

    const key = sessionKeyFor(dgram.clientRandom, dgram.dcid);
    let query: DnsMessage;
    try {
      query = decodeDnsMessage(decryptBytes(key, dgram.streamId, dgram.ciphertext));
    } catch {
      return;
    }
    const responseBytes = encodeDnsMessage(handler(query));
    const reply: QuicServerDatagram = {
      quic: QUIC_VERSION,
      dcid: dgram.dcid,
      streamId: dgram.streamId,
      ciphertext: encryptBytes(key, dgram.streamId + 1, responseBytes),
    };
    host.sendUdpDatagramTo(sourceIP, udp.sourcePort, port, reply, reply.ciphertext.length);
  }, 'doq');
}

export function unbindDnsQuicServer(host: EndHost, port: number = DOQ_PORT): void {
  host.udpClose(port);
}

let connectionCounter = 0;

export class DnsQuicClient {
  private readonly dcid: string;
  private readonly clientRandom: string;
  private readonly sessionKey: string;
  private readonly port: number;
  private readonly alpn: string;
  private readonly timeoutMs: number;
  private nextStreamId = 0;

  lastStreamId = -1;

  constructor(
    private readonly host: EndHost,
    private readonly serverIP: IPAddress,
    options: DoqOptions = {},
  ) {
    connectionCounter++;
    this.dcid = `dcid-${connectionCounter}`;
    this.clientRandom = `quic-cli-${connectionCounter}`;
    this.sessionKey = sessionKeyFor(this.clientRandom, this.dcid);
    this.port = options.port ?? DOQ_PORT;
    this.alpn = options.alpn ?? DOQ_ALPN;
    this.timeoutMs = options.timeoutMs ?? 2000;
  }

  async query(message: DnsMessage): Promise<DnsMessage | null> {
    const streamId = this.nextStreamId;
    this.nextStreamId += STREAM_STRIDE;
    this.lastStreamId = streamId;

    let sourcePort: number;
    try {
      sourcePort = this.host.getSocketTable().allocateEphemeralPort();
    } catch {
      return null;
    }

    return new Promise<DnsMessage | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const finish = (result: DnsMessage | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.host.udpClose(sourcePort);
        resolve(result);
      };

      try {
        this.host.udpBind(sourcePort, ({ udp }) => {
          if (!isQuicServerDatagram(udp.payload)) return;
          const dgram = udp.payload;
          if (dgram.dcid !== this.dcid || dgram.streamId !== streamId) return;
          try {
            const response = decodeDnsMessage(decryptBytes(this.sessionKey, streamId + 1, dgram.ciphertext));
            finish(response.id === message.id ? response : null);
          } catch {
            finish(null);
          }
        }, 'doq-client');
      } catch {
        resolve(null);
        return;
      }

      const datagram: QuicClientDatagram = {
        quic: QUIC_VERSION,
        dcid: this.dcid,
        alpn: this.alpn,
        clientRandom: this.clientRandom,
        streamId,
        ciphertext: encryptBytes(this.sessionKey, streamId, encodeDnsMessage(message)),
      };
      const sent = this.host.sendUdpDatagram(
        this.serverIP, this.port, sourcePort, datagram, datagram.ciphertext.length,
      );
      if (!sent) {
        finish(null);
        return;
      }
      timer = setTimeout(() => finish(null), this.timeoutMs);
    });
  }
}

export async function queryDnsOverQuic(
  host: EndHost,
  serverIP: IPAddress,
  query: DnsMessage,
  options: DoqOptions = {},
): Promise<DnsMessage | null> {
  return new DnsQuicClient(host, serverIP, options).query(query);
}

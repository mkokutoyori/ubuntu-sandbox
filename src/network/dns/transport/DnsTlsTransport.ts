/**
 * DNS over TLS (RFC 7858, TCP/853) — bridges DNS query/response framing
 * onto a real RFC 8446 1-RTT handshake (`TlsClientSession`/
 * `TlsServerSession`, `@/network/tls`) instead of `SimulatedTls.ts`'s
 * symmetric-key stand-in (`PRD-TLS.md` §2.1.14). `DnsQuicTransport.ts`
 * (DoQ) still uses `SimulatedTls.ts` — it migrates under `PRD-QUIC.md`
 * once that engine is ready to carry TLS 1.3 itself.
 *
 * Both sides trust a single well-known CA (`getOrCreateCA(DOT_TRUST_ANCHOR_KEY)`,
 * `@/network/pki/PkiCaRegistry`) — the simulator's equivalent of a public
 * DoT resolver's certificate already being signed by a publicly-trusted
 * root, so no enrollment step is needed before `bindDnsTlsServer`/
 * `queryDnsOverTls` can be used, matching the pre-migration API exactly.
 */

import type { IPAddress, IPv6Address } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import {
  addressOf, connectDnsStream, type DnsStreamFailure, type DnsStreamHandler, type DnsStreamReply,
} from '@/network/dns/transport/DnsTcpTransport';
import { answersQuestion } from '@/network/dns/transport/DnsUdpTransport';
import { tlsVerifyFailureText } from '@/network/dns/transport/DnsTlsVerification';
import { getOrCreateCA } from '@/network/pki/PkiCaRegistry';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { ServerIdentity } from '@/network/http/https/ServerTlsToolkit';
import type { TlsProtocolVersion } from '@/network/tls/legacy/legacyCipherSuites';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { TlsServerChannel } from '@/network/tls/TlsServerChannel';
import { TlsClientChannel } from '@/network/tls/TlsClientChannel';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { runTlsHandshakeOverSocket } from '@/network/http/https/TlsRecordWire';
import { DnsStreamReader, frameDnsMessage } from '@/network/dns/transport/DnsStreamFraming';
import { DnsStreamLifetime, type DnsStreamTimeouts } from '@/network/dns/transport/DnsStreamTimeouts';
import type { DohClientIdentity } from '@/network/dns/transport/DnsHttpsTransport';
import { dnsTlsServerOptions, type DnsTlsServerSettings } from '@/network/dns/transport/DnsTlsServerSettings';

export const DOT_PORT = 853;
export const DOT_ALPN = 'dot';

const DOT_TRUST_ANCHOR_KEY = 'dot-well-known-root';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface DotOptions {
  readonly port?: number;
  readonly alpn?: string;
  readonly sni?: string;
  readonly serverName?: string;
  readonly timeoutMs?: number;
  readonly identity?: ServerIdentity;
  readonly protocols?: readonly TlsProtocolVersion[];
  readonly address?: string;
  readonly processName?: string;
  readonly pid?: number;
  readonly service?: string;
  readonly anchors?: readonly X509Certificate[];
  readonly verifyPeer?: boolean;
  readonly onVerifyFailure?: (text: string) => void;
  readonly settings?: DnsTlsServerSettings;
  readonly requireAlpn?: boolean;
  readonly silentRejection?: boolean;
  readonly onStreamFailure?: (failure: DnsStreamFailure) => void;
  readonly clientIdentity?: DohClientIdentity;
  readonly timeouts?: () => DnsStreamTimeouts;
}

function concatenated(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function framedReply(reply: DnsStreamReply): Uint8Array {
  const messages = reply === null ? [] : Array.isArray(reply) ? reply : [reply as DnsMessage];
  return concatenated(messages.map((message) => frameDnsMessage(encodeDnsMessage(message))));
}

export function bindDnsTlsServer(host: EndHost, handler: DnsStreamHandler, options: DotOptions = {}): void {
  const alpn = options.alpn ?? DOT_ALPN;
  const now = host.getTcpStack().nowMs();
  const identity: ServerIdentity = options.identity ?? (() => {
    const issued = getOrCreateCA(DOT_TRUST_ANCHOR_KEY).issueCertificate({
      subject: `CN=${options.sni ?? host.getHostname()}`, notBefore: now - 1000, notAfter: now + ONE_YEAR_MS,
    });
    return { cert: issued.cert, key: issued.privateKey, chain: [] };
  })();
  const tlsOptions = dnsTlsServerOptions(options.settings, () => host.getTcpStack().nowMs());
  const protocols = options.protocols ?? tlsOptions.protocols;

  host.getTcpStack().listen(options.port ?? DOT_PORT, {
    identity: { processName: options.processName ?? 'dnsmasq', pid: options.pid, service: options.service },
    onAccept: (socket: TcpSocket) => {
      const tls = new TlsServerSession({
        serverCert: identity.cert, serverPrivateKey: identity.key, serverChain: identity.chain, alpnProtocols: [alpn],
        ...(options.requireAlpn === false ? { alpnMismatch: 'ignore' as const } : {}),
        ...tlsOptions, ...(protocols === undefined ? {} : { protocols }),
      });
      const reader = new DnsStreamReader();
      const timeouts = options.timeouts?.();
      const lifetime = timeouts === undefined ? null : new DnsStreamLifetime(() => socket.close(), timeouts);
      socket.onClose(() => lifetime?.stop());
      const serve = (raw: Uint8Array): void => {
        let query: DnsMessage;
        try {
          query = decodeDnsMessage(raw);
        } catch {
          socket.close();
          return;
        }
        lifetime?.requested(query);
        const send = (reply: DnsStreamReply): void => channel.write(framedReply(lifetime?.answered(query, reply) ?? reply));
        const answer = handler(query, addressOf(socket.remoteIp), socket.remotePort, raw, addressOf(socket.localIp));
        if (answer instanceof Promise) void answer.then(send, () => socket.close());
        else send(answer);
      };
      const channel: TlsServerChannel = new TlsServerChannel(socket, tls, {
        silentRejection: options.silentRejection === true,
        onHandshakeRejected: () => socket.close(),
        onHandshakeComplete: () => {
          if (options.requireAlpn !== false && tls.negotiatedAlpnProtocol !== alpn) socket.close();
        },
        onData: (plaintext) => {
          let messages: Uint8Array[];
          try {
            messages = reader.push(plaintext);
          } catch {
            socket.close();
            return;
          }
          for (const raw of messages) serve(raw);
        },
      });
    },
  }, options.address ?? '0.0.0.0');
}

export function unbindDnsTlsServer(host: EndHost, port: number = DOT_PORT, address = '0.0.0.0'): void {
  host.getTcpStack().closeListener(port, address);
}

export interface DnsStreamExchange {
  readonly messages: DnsMessage[];
  readonly frames: Uint8Array[];
}

async function exchangeOverTls(
  host: EndHost,
  serverIP: IPAddress | IPv6Address,
  query: DnsMessage,
  isComplete: (messages: readonly DnsMessage[]) => boolean,
  options: DotOptions,
): Promise<DnsStreamExchange | null> {
  const socket = await connectDnsStream(host, serverIP.toString(), options.port ?? DOT_PORT, options.onStreamFailure);
  if (!socket) return null;

  const alpn = options.alpn ?? DOT_ALPN;
  const timeoutMs = options.timeoutMs ?? 2000;
  const anchors = options.anchors ?? [getOrCreateCA(DOT_TRUST_ANCHOR_KEY).rootCertificate];
  const verifier = new CertificateVerifier({ trustAnchors: anchors, clock: () => host.getTcpStack().nowMs() });
  const client = new TlsClientSession({
    verifier, alpn: [alpn], allowUntrustedPeer: options.verifyPeer === false,
    ...(options.serverName !== undefined ? { serverName: options.serverName } : {}),
    ...(options.clientIdentity === undefined ? {} : {
      clientCert: options.clientIdentity.certificate, clientChain: options.clientIdentity.chain,
      clientPrivateKey: options.clientIdentity.privateKey,
    }),
  });

  const trailing: TlsRecord[] = [];
  runTlsHandshakeOverSocket(socket, client, (records) => { trailing.push(...records); });
  if (client.result !== 'success') {
    if (client.peerVerificationReason !== null) {
      options.onVerifyFailure?.(tlsVerifyFailureText(client.peerVerificationReason, client.peerCertificate, client.peerCertificateChain));
    } else {
      options.onStreamFailure?.('tls');
    }
    socket.close();
    return null;
  }

  return new Promise<DnsStreamExchange | null>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (result: DnsStreamExchange | null, failure?: DnsStreamFailure): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (result === null && failure !== undefined) options.onStreamFailure?.(failure);
      resolve(result);
      socket.close();
    };

    const messages: DnsMessage[] = [];
    const frames: Uint8Array[] = [];
    const reader = new DnsStreamReader();
    const channel = new TlsClientChannel(socket, client);
    channel.onPushBytes((plaintext) => {
      try {
        for (const raw of reader.push(plaintext)) {
          const message = decodeDnsMessage(raw);
          if (!answersQuestion(query, message)) continue;
          messages.push(message);
          frames.push(raw);
          if (isComplete(messages)) { finish({ messages, frames }); return; }
        }
      } catch {
        finish(null);
      }
    });
    socket.onClose(() => finish(null, 'eof'));
    timer = setTimeout(() => finish(null), timeoutMs);
    if (trailing.length > 0) channel.receiveRecords(trailing);
    channel.send(frameDnsMessage(encodeDnsMessage(query)));
  });
}

export async function queryDnsOverTls(
  host: EndHost,
  serverIP: IPAddress | IPv6Address,
  query: DnsMessage,
  options: DotOptions = {},
): Promise<DnsMessage | null> {
  const exchange = await exchangeOverTls(host, serverIP, query, (messages) => messages.length > 0, options);
  return exchange === null ? null : exchange.messages[0];
}

export function queryDnsOverTlsStream(
  host: EndHost,
  serverIP: IPAddress | IPv6Address,
  query: DnsMessage,
  isComplete: (messages: readonly DnsMessage[]) => boolean,
  options: DotOptions = {},
): Promise<DnsStreamExchange | null> {
  return exchangeOverTls(host, serverIP, query, isComplete, options);
}

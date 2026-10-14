import type { TcpStack } from '@/network/tcp/TcpStack';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { TlsClientChannel } from '@/network/tls/TlsClientChannel';
import { runTlsHandshakeOverSocket } from '@/network/http/https/TlsRecordWire';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { TlsRecord } from '@/network/tls/recordLayer';
import {
  NKE_ALPN, NKE_EXPORTER_LABEL, aeadKeyLength, buildClientRequest, decodeRecords, endOfMessage, exporterContext, parseServerResponse,
} from './NtsKeRecords';
import type { NtsContext } from './NtsClient';

export interface NtsKeResult {
  readonly context: NtsContext;
  readonly cookies: Uint8Array[];
  readonly ntpServer: string | null;
  readonly ntpPort: number | null;
}

export interface NtsKeOutcome {
  readonly ok: boolean;
  readonly result?: NtsKeResult;
  readonly reason?: string;
  readonly stage?: 'connect' | 'tls' | 'response';
}

export function runNtsKe(
  tcp: TcpStack, address: string, port: number, serverName: string, verifier: CertificateVerifier,
): NtsKeOutcome {
  const socket = tcp.connect(address, port);
  if (!socket || socket.state !== 'established') return { ok: false, reason: 'connection failed', stage: 'connect' };
  const tls = new TlsClientSession({ verifier, alpn: [NKE_ALPN], versions: ['1.3'], serverName, verifyHostname: true });
  const trailing: TlsRecord[] = [];
  runTlsHandshakeOverSocket(socket, tls, (records) => { trailing.push(...records); });
  if (tls.result !== 'success' || tls.negotiatedAlpnProtocol !== NKE_ALPN) {
    socket.close();
    return { ok: false, reason: tls.result !== 'success' ? 'TLS handshake failed' : 'ALPN not negotiated', stage: 'tls' };
  }
  const channel = new TlsClientChannel(socket, tls);
  if (trailing.length > 0) channel.receiveRecords(trailing);
  const reply = channel.exchange(buildClientRequest());
  socket.close();
  const records = decodeRecords(reply);
  if (records === null || !endOfMessage(records)) return { ok: false, reason: 'truncated response', stage: 'response' };
  const parsed = parseServerResponse(records);
  if (parsed.ok === false) return { ok: false, reason: parsed.reason, stage: 'response' };
  const length = aeadKeyLength(parsed.response.aead);
  const c2s = tls.exportKeyingMaterial(NKE_EXPORTER_LABEL, exporterContext(parsed.response.aead, 'c2s'), length);
  const s2c = tls.exportKeyingMaterial(NKE_EXPORTER_LABEL, exporterContext(parsed.response.aead, 's2c'), length);
  if (c2s === null || s2c === null) return { ok: false, reason: 'no exporter', stage: 'response' };
  return {
    ok: true,
    result: {
      context: { aead: parsed.response.aead, c2s, s2c }, cookies: parsed.response.cookies,
      ntpServer: parsed.response.server, ntpPort: parsed.response.port,
    },
  };
}

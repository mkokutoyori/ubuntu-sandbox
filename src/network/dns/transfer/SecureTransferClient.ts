import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { transferComplete } from '@/network/dns/transfer/AxfrSession';
import type { SecureTransferClient } from '@/network/dns/transfer/ZoneTransferClient';
import type { TransferEndpoint } from '@/network/dns/transfer/TransferEndpoint';
import { DOT_PORT, queryDnsOverTls, queryDnsOverTlsStream, type DotOptions } from '@/network/dns/transport/DnsTlsTransport';

function optionsFor(server: IPAddress, endpoint: TransferEndpoint, timeoutMs: number): DotOptions | null {
  const tls = endpoint.tls!;
  if (tls.setupFailed) {
    tls.report?.('setup');
    return null;
  }
  return {
    port: endpoint.port ?? DOT_PORT,
    timeoutMs,
    onVerifyFailure: () => tls.report?.('verification'),
    ...(tls.anchors === null
      ? { verifyPeer: false }
      : { verifyPeer: true, anchors: tls.anchors, serverName: tls.serverName ?? server.toString() }),
  };
}

export function secureTransferClientOf(host: EndHost): SecureTransferClient {
  return {
    single: async (server, query, timeoutMs, endpoint) => {
      const options = optionsFor(server, endpoint, timeoutMs);
      return options === null ? null : queryDnsOverTls(host, server, query, options);
    },
    stream: async (server, query, timeoutMs, endpoint) => {
      const options = optionsFor(server, endpoint, timeoutMs);
      return options === null ? null : queryDnsOverTlsStream(host, server, query, transferComplete, options);
    },
  };
}

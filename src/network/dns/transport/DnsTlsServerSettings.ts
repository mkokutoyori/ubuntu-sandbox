import type { TlsServerConfig } from '@/network/tls/TlsServerSession';
import { resolveCipherList, type TlsProtocolVersion } from '@/network/tls/legacy/legacyCipherSuites';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { DhParameters } from '@/network/pki/pem';
import { resumptionConfig } from '@/network/http/https/ServerTlsToolkit';

const SESSION_LIFETIME_SECONDS = 7200;
const DEFAULT_CIPHER_LIST = 'DEFAULT';

export interface DnsTlsServerSettings {
  readonly protocols?: readonly TlsProtocolVersion[];
  readonly ciphers?: string | null;
  readonly preferServerCiphers?: boolean;
  readonly dhParameters?: DhParameters;
  readonly clientTrustAnchors?: readonly X509Certificate[];
  readonly sessionTickets?: boolean;
}

export type DnsTlsServerOptions = Partial<Pick<TlsServerConfig,
  'protocols' | 'legacyCipherSuites' | 'preferServerCiphers' | 'dhParameters' | 'requestClientCert' | 'verifier'
  | 'clientCertPolicy' | 'sessionTicketStore' | 'sessionTicketKey' | 'sessionTimeoutSeconds'>>;

function legacySuites(settings: DnsTlsServerSettings): readonly string[] {
  const resolved = resolveCipherList(settings.ciphers ?? DEFAULT_CIPHER_LIST);
  if (resolved.ok === false) return [];
  const offersDhe = settings.dhParameters !== undefined;
  return resolved.suites
    .filter((suite) => offersDhe || suite.keyExchange !== 'DHE_RSA')
    .map((suite) => suite.name);
}

export function dnsTlsServerOptions(settings: DnsTlsServerSettings | undefined, clock: () => number): DnsTlsServerOptions {
  if (settings === undefined) return {};
  const resumption = resumptionConfig({
    tickets: settings.sessionTickets !== false, serverSideCache: false,
    timeoutSeconds: SESSION_LIFETIME_SECONDS, ticketKey: undefined,
  });
  return {
    ...(settings.protocols === undefined ? {} : { protocols: settings.protocols }),
    legacyCipherSuites: legacySuites(settings),
    preferServerCiphers: settings.preferServerCiphers === true,
    ...(settings.dhParameters === undefined ? {} : { dhParameters: settings.dhParameters }),
    ...(settings.clientTrustAnchors === undefined ? {} : {
      requestClientCert: true, clientCertPolicy: 'strict' as const,
      verifier: new CertificateVerifier({ trustAnchors: settings.clientTrustAnchors, clock }),
    }),
    ...(resumption.sessionTicketStore === undefined ? {} : { sessionTicketStore: resumption.sessionTicketStore }),
    ...(resumption.sessionTicketKey === undefined ? {} : { sessionTicketKey: resumption.sessionTicketKey }),
    sessionTimeoutSeconds: resumption.sessionTimeoutSeconds,
  };
}

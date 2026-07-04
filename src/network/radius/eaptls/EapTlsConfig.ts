import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';

/**
 * RADIUS-server-side EAP-TLS configuration (mirrors `IkeCertAuthConfig`'s
 * shape/spirit): the caller is responsible for enrolling with a CA
 * (`@/network/pki/PkiCaRegistry.getOrCreateCA`) and building the
 * `CertificateVerifier` — this engine only consumes the finished config,
 * exactly like `IPSecEngine.setIkeCertAuth` stays decoupled from PKI
 * specifics.
 */
export interface EapTlsConfig {
  readonly serverCert: X509Certificate;
  readonly verifier: CertificateVerifier;
  /** RFC 5216 mandates mutual authentication; default true. Set false only to model a non-conformant simplified deployment. */
  readonly requireClientCert?: boolean;
  readonly mtu?: number;
}

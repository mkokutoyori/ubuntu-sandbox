import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { InnerAuthServer } from './InnerAuth';

/**
 * RADIUS-server-side EAP-TLS/PEAP/EAP-TTLS configuration (mirrors
 * `IkeCertAuthConfig`'s shape/spirit): the caller is responsible for
 * enrolling with a CA (`@/network/pki/PkiCaRegistry.getOrCreateCA`) and
 * building the `CertificateVerifier` — this engine only consumes the
 * finished config, exactly like `IPSecEngine.setIkeCertAuth` stays
 * decoupled from PKI specifics.
 */
export interface EapTlsConfig {
  readonly serverCert: X509Certificate;
  readonly verifier: CertificateVerifier;
  /** RFC 5216 mandates mutual authentication; default true. PEAP/EAP-TTLS callers should pass false (client auth happens inside the tunnel instead, via `innerAuth`). */
  readonly requireClientCert?: boolean;
  readonly mtu?: number;
  /** Which outer method this session speaks on the wire — affects only the EapPacket.eapType field written; the tunnel mechanics are identical. Default 'tls'. */
  readonly eapType?: 'tls' | 'peap' | 'ttls';
  /** When set, the outer tunnel doesn't conclude in accept/reject on its own — it hands off to this inner method once established (PEAP/EAP-TTLS). Absent for plain EAP-TLS. */
  readonly innerAuth?: InnerAuthServer;
}

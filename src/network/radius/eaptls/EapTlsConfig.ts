import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { InnerAuthServer } from './InnerAuth';
import type { SessionTicketStore } from '@/network/tls/sessionTickets';

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
  /** Signs the outer tunnel's `CertificateVerify` (RFC 8446 §4.4.2) — the real 1-RTT engine needs it even though the old ad hoc 2-RTT model didn't. */
  readonly serverPrivateKey: PkiPrivateKey;
  readonly verifier: CertificateVerifier;
  /** RFC 5216 mandates mutual authentication; default true. PEAP/EAP-TTLS callers should pass false (client auth happens inside the tunnel instead, via `innerAuth`). */
  readonly requireClientCert?: boolean;
  readonly mtu?: number;
  /** Which outer method this session speaks on the wire — affects only the EapPacket.eapType field written; the tunnel mechanics are identical. Default 'tls'. */
  readonly eapType?: 'tls' | 'peap' | 'ttls';
  /** When set, the outer tunnel doesn't conclude in accept/reject on its own — it hands off to this inner method once established (PEAP/EAP-TTLS). Absent for plain EAP-TLS. */
  readonly innerAuth?: InnerAuthServer;
  /** RFC 9190 section 2.1.2: EAP-TLS tickets. When set (plain EAP-TLS only) the server issues a ticket after a full handshake, delivers it in one more EAP round before the success, and resumes a peer that presents a live one without a certificate exchange. */
  readonly resumption?: { readonly store: SessionTicketStore; readonly lifetimeSeconds: number };
}

import { CertificateAuthority } from '../../../pki/CertificateAuthority';
import { certToPem, privateKeyToPem } from '../../../pki/pem';
import type { CertificateStore } from './CertificateStore';

export const FACTORY_SSL_CA = 'Fortinet_CA_SSL';
export const FACTORY_UNTRUSTED_CA = 'Fortinet_CA_Untrusted';
export const FACTORY_DEVICE_CERT = 'Fortinet_Factory';
export const FACTORY_ADMIN_CERT = 'self-sign';

const SSL_CA_SUBJECT =
  'C = US, ST = California, L = Sunnyvale, O = Fortinet, OU = Certificate Authority, CN = FortiGate CA';
const UNTRUSTED_CA_SUBJECT =
  'C = US, ST = California, L = Sunnyvale, O = Fortinet, OU = Certificate Authority, '
  + 'CN = FortiGate Untrusted CA';
const DEVICE_SUBJECT =
  'C = US, ST = California, L = Sunnyvale, O = Fortinet, OU = FortiGate, CN = FGT-factory';
const ADMIN_SUBJECT =
  'C = US, ST = California, L = Sunnyvale, O = Fortinet, OU = FortiGate, CN = FortiGate';

const TEN_YEARS_MS = 10 * 365 * 24 * 3600 * 1000;

export function seedFactoryCertificates(store: CertificateStore, now: number): void {
  for (const [name, subject] of [
    [FACTORY_SSL_CA, SSL_CA_SUBJECT],
    [FACTORY_UNTRUSTED_CA, UNTRUSTED_CA_SUBJECT],
    [FACTORY_DEVICE_CERT, DEVICE_SUBJECT],
    [FACTORY_ADMIN_CERT, ADMIN_SUBJECT],
  ] as const) {
    store.setLocalOnFirstRead(name, () => {
      const ca = CertificateAuthority.generate(subject, { now, validityMs: TEN_YEARS_MS });
      return {
        name,
        certificate: ca.rootCertificate,
        privateKey: ca.signingKey,
        certificatePem: certToPem(ca.rootCertificate),
        privateKeyPem: privateKeyToPem(ca.signingKey),
        comments: 'Factory certificate.',
        source: 'factory',
      };
    });
  }

  store.setAuthorityOnFirstRead(FACTORY_SSL_CA, () => {
    const sslCa = store.local(FACTORY_SSL_CA)!;
    return {
      name: FACTORY_SSL_CA,
      certificate: sslCa.certificate,
      certificatePem: sslCa.certificatePem,
      trusted: true,
    };
  });
}

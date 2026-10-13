import { reserveCaSerial } from './CertificateAuthority';
import { reserveSelfSignedSerial } from './SelfSignedCertificate';

export function reserveCertificateSerial(serial: string): void {
  reserveCaSerial(serial);
  reserveSelfSignedSerial(serial);
}

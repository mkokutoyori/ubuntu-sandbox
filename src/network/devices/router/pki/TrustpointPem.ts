import { PkiKeyPair, type PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import { tbsPayload, type X509Certificate } from '@/network/pki/X509Certificate';
import {
  certToPem, pemToCert, traditionalEncryptedKeyToPem, pemToPrivateKeyWithPassphrase,
  isEncryptedPrivateKeyPem,
} from '@/network/pki/pem';
import { systemRandom } from '@/crypto/random';
import type { PkiTrustpoint } from '../security/CiscoSecurityConfig';

export const MIN_PASSPHRASE_LENGTH = 8;

export type PemCipher = '3des' | 'des';

const CIPHER_NAME = { '3des': 'des-ede3-cbc', des: 'des-cbc' } as const;

export type PemExport = { readonly text: string } | { readonly error: string };

export function passphraseProblem(phrase: string): string | null {
  return phrase.length < MIN_PASSPHRASE_LENGTH
    ? `% Password phrase must be at least ${MIN_PASSPHRASE_LENGTH} characters long`
    : null;
}

export function exportTrustpointPem(trustpoint: PkiTrustpoint, cipher: PemCipher, phrase: string): PemExport {
  const problem = passphraseProblem(phrase);
  if (problem) return { error: problem };
  if (!trustpoint.caCert && !trustpoint.localCert) return { error: `% Trustpoint ${trustpoint.name} holds no certificate to export` };
  const blocks: string[] = [];
  if (trustpoint.caCert) blocks.push('% CA certificate:', certToPem(trustpoint.caCert).trimEnd());
  if (trustpoint.localKey) {
    if (!trustpoint.keyExportable) return { error: `% Key of trustpoint ${trustpoint.name} is not exportable` };
    blocks.push(
      `% Key name: ${trustpoint.rsaKeypair ?? trustpoint.name}`, '   Usage: General Purpose Key',
      traditionalEncryptedKeyToPem(trustpoint.localKey, phrase, CIPHER_NAME[cipher], systemRandom).trimEnd(),
    );
  }
  if (trustpoint.localCert) blocks.push('% General Purpose Certificate:', certToPem(trustpoint.localCert).trimEnd());
  return { text: `${blocks.join('\n')}\n` };
}

const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const KEY_BLOCK = /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;

const signsFor = (key: PkiPrivateKey, certificate: X509Certificate): boolean => {
  const probe = new Uint8Array([0x49, 0x4f, 0x53]);
  return PkiKeyPair.verify(certificate.publicKey, probe, PkiKeyPair.sign(key, probe));
};

const issuedBy = (certificate: X509Certificate, authority: X509Certificate): boolean =>
  certificate.issuer === authority.subject
  && PkiKeyPair.verify(authority.publicKey, tbsPayload(certificate), certificate.signature);

export interface PemImport {
  readonly caCert?: X509Certificate;
  readonly localCert?: X509Certificate;
  readonly localKey?: PkiPrivateKey;
  readonly error?: string;
}

export function parseTrustpointPem(text: string, phrase: string | null): PemImport {
  const certificates = (text.match(CERTIFICATE_BLOCK) ?? []).map((block) => pemToCert(block));
  if (certificates.some((certificate) => certificate === null)) return { error: '% A certificate in the PEM text could not be read' };
  const parsed = certificates as X509Certificate[];
  const keyBlock = KEY_BLOCK.exec(text)?.[0] ?? null;
  let localKey: PkiPrivateKey | undefined;
  if (keyBlock !== null) {
    if (isEncryptedPrivateKeyPem(keyBlock) && phrase === null) return { error: '% The private key is encrypted: a password phrase is required' };
    const key = pemToPrivateKeyWithPassphrase(keyBlock, phrase);
    if (key === null) return { error: '% Unable to decrypt the private key: wrong password phrase or damaged PEM' };
    localKey = key;
  }
  if (parsed.length === 0) return { error: '% No certificate found in the PEM text' };
  if (localKey === undefined) {
    if (parsed.length > 1) return { error: '% Without a private key only the CA certificate can be imported' };
    return { caCert: parsed[0] };
  }
  const localCert = parsed.find((certificate) => signsFor(localKey!, certificate));
  if (!localCert) return { error: '% The private key does not match any certificate in the PEM text' };
  const caCert = parsed.find((certificate) => certificate !== localCert && issuedBy(localCert, certificate));
  if (!caCert) return { error: '% The router certificate is not issued by any CA certificate in the PEM text' };
  return { caCert, localCert, localKey };
}

export function installTrustpointPem(trustpoint: PkiTrustpoint, imported: PemImport, exportable: boolean): void {
  trustpoint.caCert = imported.caCert ?? trustpoint.caCert;
  if (imported.localCert && imported.localKey) {
    trustpoint.localCert = imported.localCert;
    trustpoint.localKey = imported.localKey;
    trustpoint.keyExportable = exportable;
  }
}

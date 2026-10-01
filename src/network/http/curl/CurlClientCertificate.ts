import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import { pemToCertChain, pemToPrivateKey, pemToEncryptedPrivateKey, isEncryptedPrivateKeyPem } from '@/network/pki/pem';
import { privateKeyPairsWith } from '@/network/pki/keyPairing';
import type { CurlOptions } from './CurlArgs';

export interface CurlClientCredential {
  readonly cert: X509Certificate;
  readonly chain: readonly X509Certificate[];
  readonly key: PkiPrivateKey;
}

export type CurlClientCredentialResult =
  | { readonly ok: true; readonly credential: CurlClientCredential | null }
  | { readonly ok: false; readonly message: string };

const CERT_FAILURE_TAIL = '(no key found, wrong pass phrase, or wrong file format?)';

function certificateFailure(file: string, reason: string): CurlClientCredentialResult {
  return {
    ok: false,
    message: `curl: (58) could not load PEM client certificate from ${file}, OpenSSL error ${reason}, ${CERT_FAILURE_TAIL}`,
  };
}

export function loadCurlClientCredential(
  options: Pick<CurlOptions, 'cert' | 'key' | 'keyPassphrase'>, readFile: (path: string) => string | null,
): CurlClientCredentialResult {
  if (options.cert === null) return { ok: true, credential: null };
  const certPem = readFile(options.cert);
  if (certPem === null) return certificateFailure(options.cert, 'error:80000002:system library::No such file or directory');
  const certificates = pemToCertChain(certPem);
  if (certificates.length === 0) return certificateFailure(options.cert, 'error:0480006C:PEM routines::no start line');
  const keyFile = options.key ?? options.cert;
  const keyPem = options.key === null ? certPem : readFile(options.key);
  const keyFailure: CurlClientCredentialResult = { ok: false, message: `curl: (58) unable to set private key file: '${keyFile}' type PEM` };
  if (keyPem === null) return keyFailure;
  const key = isEncryptedPrivateKeyPem(keyPem)
    ? (options.keyPassphrase === null ? null : pemToEncryptedPrivateKey(keyPem, options.keyPassphrase))
    : pemToPrivateKey(keyPem);
  if (key === null) return keyFailure;
  if (!privateKeyPairsWith(certificates[0].publicKey, key)) {
    return { ok: false, message: 'curl: (58) Private key does not match the certificate public key' };
  }
  return { ok: true, credential: { cert: certificates[0], chain: certificates.slice(1), key } };
}

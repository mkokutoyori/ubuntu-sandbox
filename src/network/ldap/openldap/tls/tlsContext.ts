import { privateKeyPairsWith } from '@/network/pki/keyPairing';
import { pemToCertChain, pemToCrl, pemToPrivateKey } from '@/network/pki/pem';
import type { CertificateRevocationList } from '@/network/pki/CertificateRevocationList';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { TlsDebug } from '../ldapChannel';
import { LdapDebug } from '../ldapLog';
import type { LdapOptions } from '../ldapOptions';
import {
  GNUTLS_E_BASE64_DECODING_ERROR, GNUTLS_E_CERTIFICATE_KEY_MISMATCH, GNUTLS_E_FILE_ERROR, GNUTLS_E_NO_CERTIFICATE_FOUND,
  GNUTLS_E_REQUESTED_DATA_NOT_AVAILABLE, GNUTLS_E_SUCCESS, gnutlsStrerror,
} from './gnutlsErrors';

export interface TlsFiles {
  read(path: string): { readonly bytes: Uint8Array } | { readonly error: string };
  regularFiles(directory: string): readonly string[] | null;
}

export interface TlsContext {
  readonly trustAnchors: readonly X509Certificate[];
  readonly revocationLists: readonly CertificateRevocationList[];
  readonly clientCertificates: readonly X509Certificate[];
  readonly clientKey: PkiPrivateKey | null;
}

export type TlsContextInit =
  | { readonly ok: true; readonly context: TlsContext }
  | { readonly ok: false; readonly errmsg: string };

const CERTIFICATE_PATH_SEPARATOR = ';';
const decoder = new TextDecoder();

function textOf(files: TlsFiles, path: string): string | null {
  const content = files.read(path);
  return 'error' in content ? null : decoder.decode(content.bytes);
}

export function initTlsContext(tls: LdapOptions['tls'], files: TlsFiles, debug: TlsDebug): TlsContextInit {
  let errmsg = '';
  const trustAnchors: X509Certificate[] = [];

  if (tls.caCertDir !== null) {
    for (const directory of tls.caCertDir.split(CERTIFICATE_PATH_SEPARATOR).filter((part) => part !== '')) {
      const loaded: X509Certificate[] = [];
      for (const name of files.regularFiles(directory) ?? []) {
        const text = textOf(files, `${directory}/${name}`);
        if (text !== null) loaded.push(...pemToCertChain(text));
      }
      if (loaded.length > 0) {
        debug(LdapDebug.TRACE, `TLS: loaded ${loaded.length} CA certificates from directory \`${directory}'.\n`);
        trustAnchors.push(...loaded);
      } else {
        debug(LdapDebug.ANY, `TLS: warning: no certificate found in CA certificate directory \`${directory}'.\n`);
        errmsg = gnutlsStrerror(GNUTLS_E_SUCCESS);
      }
    }
  }

  if (tls.caCertFile !== null) {
    const text = textOf(files, tls.caCertFile);
    if (text === null) {
      debug(
        LdapDebug.ANY,
        `TLS: could not use CA certificate file \`${tls.caCertFile}': ${gnutlsStrerror(GNUTLS_E_FILE_ERROR)} (${GNUTLS_E_FILE_ERROR})\n`,
      );
      return { ok: false, errmsg };
    }
    const loaded = pemToCertChain(text);
    if (loaded.length === 0) {
      debug(LdapDebug.ANY, `TLS: warning: no certificate loaded from CA certificate file \`${tls.caCertFile}'.\n`);
      errmsg = gnutlsStrerror(GNUTLS_E_SUCCESS);
    }
    trustAnchors.push(...loaded);
  }

  let clientCertificates: readonly X509Certificate[] = [];
  let clientKey: PkiPrivateKey | null = null;
  if (tls.certFile !== null && tls.keyFile !== null) {
    const keyText = getfile(files, tls.keyFile, debug);
    if (keyText === null) {
      debug(LdapDebug.ANY, `TLS: could not use private key file \`${tls.keyFile}\`.\n`);
      return { ok: false, errmsg };
    }
    clientKey = pemToPrivateKey(keyText);
    if (clientKey === null) {
      return failure(debug, 'could not use private key', GNUTLS_E_REQUESTED_DATA_NOT_AVAILABLE);
    }
    const certText = getfile(files, tls.certFile, debug);
    if (certText === null) {
      debug(LdapDebug.ANY, `TLS: could not use certificate file \`${tls.certFile}\`.\n`);
      return { ok: false, errmsg };
    }
    clientCertificates = pemToCertChain(certText);
    if (clientCertificates.length === 0) {
      return failure(debug, 'could not use certificate', GNUTLS_E_NO_CERTIFICATE_FOUND);
    }
    if (!privateKeyPairsWith(clientCertificates[0].publicKey, clientKey)) {
      return failure(debug, 'could not use certificate with key', GNUTLS_E_CERTIFICATE_KEY_MISMATCH);
    }
  } else if (tls.certFile !== null || tls.keyFile !== null) {
    debug(LdapDebug.ANY, 'TLS: only one of certfile and keyfile specified\n');
    return { ok: false, errmsg };
  }

  const revocationLists: CertificateRevocationList[] = [];
  if (tls.crlFile !== null) {
    const text = textOf(files, tls.crlFile);
    if (text === null) return { ok: false, errmsg: gnutlsStrerror(GNUTLS_E_FILE_ERROR) };
    const list = pemToCrl(text);
    if (list === null) return { ok: false, errmsg: gnutlsStrerror(GNUTLS_E_BASE64_DECODING_ERROR) };
    revocationLists.push(list);
  }

  return { ok: true, context: { trustAnchors, revocationLists, clientCertificates, clientKey } };
}

const IS_A_DIRECTORY = 'Is a directory';

function getfile(files: TlsFiles, path: string, debug: TlsDebug): string | null {
  const content = files.read(path);
  if ('error' in content) {
    if (content.error !== IS_A_DIRECTORY) debug(LdapDebug.ANY, `TLS: opening \`${path}' failed: ${content.error}\n`);
    return null;
  }
  return decoder.decode(content.bytes);
}

function failure(debug: TlsDebug, what: string, code: number): TlsContextInit {
  debug(LdapDebug.ANY, `TLS: ${what}: ${gnutlsStrerror(code)} (${code})\n`);
  return { ok: false, errmsg: gnutlsStrerror(code) };
}

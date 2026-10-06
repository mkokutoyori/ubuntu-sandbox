import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { CertificateRevocationList } from '@/network/pki/CertificateRevocationList';
import type { OcspStapleSource } from '@/network/tls/ocspStapling';
import { OcspClient, WireOcspResponder, DEFAULT_OCSP_POLICY, ocspUrlOf, parseOcspUrl, type OcspWireDeps } from '@/network/http/ocsp/OcspHttpClient';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import type { OcspResponseMessage } from '@/network/pki/OcspWire';
import { decodeOcspResponse } from '@/network/pki/der/OcspDer';
import { sameSerial } from '@/network/pki/der/X509Der';
import { binaryStringToBytes } from '@/crypto/encoding';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import {
  pemToCertChain, pemToPrivateKey, pemToEncryptedPrivateKey, isEncryptedPrivateKeyPem,
  pemToDhParameters, type DhParameters,
} from '@/network/pki/pem';
import {
  fopenFailure, loadLocationsFailure, ticketKeyFromFile, crlsFromPem, buildClientVerifier, anchorsFromPem,
  type ServerIdentity,
} from '@/network/http/https/ServerTlsToolkit';
import { resolveCipherList, type TlsProtocolVersion } from '@/network/tls/legacy/legacyCipherSuites';
import {
  applySslConfCommand, createSslConfState, effectiveProtocols, formatSslConfError, parseGroupList,
} from '@/network/tls/legacy/sslConf';
import { privateKeyPairsWith } from '@/network/pki/keyPairing';
import type { NginxServerBlock } from './NginxConfig';
import type { NginxSslSettings } from './NginxSsl';

export interface NginxTlsFiles {
  read(path: string): string | null;
}

export interface TlsProblem { readonly error: string }

export function isTlsProblem(value: unknown): value is TlsProblem {
  return typeof value === 'object' && value !== null && 'error' in value;
}

export interface ServerTls {
  readonly settings: NginxSslSettings;
  readonly identity: ServerIdentity | null;
  readonly verifier: CertificateVerifier | null;
  readonly protocols: readonly TlsProtocolVersion[];
  readonly cipherList: string;
  readonly tls13Ciphersuites: string | undefined;
  readonly groups: readonly string[];
  readonly preferServerCiphers: boolean;
  readonly sessionTickets: boolean;
  readonly extendedMasterSecret: boolean | undefined;
  readonly ticketKey: Uint8Array | undefined;
  readonly staple: OcspStapleSource | undefined;
  readonly warnings: readonly string[];
  readonly dhParameters: DhParameters | undefined;
  readonly fingerprint: string;
}

export type { ServerIdentity };

export const DEFAULT_ECDH_GROUPS: readonly string[] = ['x25519', 'secp256r1'];

const PROTOCOL_BY_NGINX_NAME: Readonly<Record<string, TlsProtocolVersion>> = {
  TLSv1: '1.0', 'TLSv1.1': '1.1', 'TLSv1.2': '1.2', 'TLSv1.3': '1.3',
};

function bytesToHexText(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function readPasswords(path: string | null, files: NginxTlsFiles): readonly string[] | TlsProblem {
  if (path === null) return [];
  const text = files.read(path);
  if (text === null) return { error: `open() "${path}" failed (2: No such file or directory)` };
  return text.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.length > 0);
}

export function loadServerTls(
  server: NginxServerBlock, files: NginxTlsFiles, wire: OcspWireDeps | null = null,
): ServerTls | TlsProblem {
  const settings = server.ssl;
  const fail = (message: string): TlsProblem => ({ error: `nginx: [emerg] ${message}` });

  const cipherSource = settings.ciphers;
  const cipherList = resolveCipherList(cipherSource);
  if (cipherList.ok === false) {
    return fail(`SSL_CTX_set_cipher_list("${cipherSource}") failed (SSL: ${cipherList.error})`);
  }

  const passwords = readPasswords(settings.passwordFile, files);
  if (isTlsProblem(passwords)) return fail(passwords.error.replace(/^nginx: \[emerg\] /, ''));

  if (settings.certificates.length === 0 && !settings.rejectHandshake) {
    return fail('no "ssl_certificate" is defined for the "listen ... ssl" directive');
  }
  let leafChain: X509Certificate[] = [];
  let key: PkiPrivateKey | null = null;
  for (let i = 0; i < settings.certificates.length; i++) {
    const path = settings.certificates[i];
    const keyFile = settings.certificateKeys[i];
    const certPem = files.read(path);
    if (certPem === null) {
      return fail(`cannot load certificate "${path}": BIO_new_file() failed (SSL: ${fopenFailure(path)})`);
    }
    const keyPem = files.read(keyFile);
    if (keyPem === null) {
      return fail(`cannot load certificate key "${keyFile}": BIO_new_file() failed (SSL: ${fopenFailure(keyFile)})`);
    }
    const parsedChain = pemToCertChain(certPem);
    if (parsedChain.length === 0) {
      return fail(`PEM_read_bio_X509_AUX("${path}") failed `
        + '(SSL: error:0480006C:PEM routines::no start line:Expecting: TRUSTED CERTIFICATE)');
    }
    let parsedKey: PkiPrivateKey | null = null;
    if (isEncryptedPrivateKeyPem(keyPem)) {
      for (const password of passwords) {
        parsedKey = pemToEncryptedPrivateKey(keyPem, password);
        if (parsedKey) break;
      }
      if (!parsedKey) {
        const reason = passwords.length === 0
          ? 'error:04800068:PEM routines::bad password read'
          : 'error:1C800064:Provider routines::bad decrypt error:11800074:PKCS12 routines::pkcs12 cipherfinal error';
        return fail(`cannot load certificate key "${keyFile}": PEM_read_bio_PrivateKey() failed (SSL: ${reason})`);
      }
    } else {
      parsedKey = pemToPrivateKey(keyPem);
    }
    if (!parsedKey) {
      return fail(`cannot load certificate key "${keyFile}": `
        + 'PEM_read_bio_PrivateKey() failed (SSL: error:0480006C:PEM routines::no start line)');
    }
    if (!privateKeyPairsWith(parsedChain[0].publicKey, parsedKey)) {
      return fail(`SSL_CTX_use_PrivateKey("${keyFile}") failed (SSL: error:05800074:x509 certificate routines::key values mismatch)`);
    }
    if (i === 0) { leafChain = parsedChain; key = parsedKey; }
  }

  let verifier: CertificateVerifier | null = null;
  if (settings.verifyClient !== 'off' || settings.trustedCertificate !== '') {
    const anchorTexts: string[] = [];
    for (const path of [settings.clientCertificate, settings.trustedCertificate]) {
      if (path === '') continue;
      const pem = files.read(path);
      if (pem === null) return fail(loadLocationsFailure(path));
      anchorTexts.push(pem);
    }
    let crls: CertificateRevocationList[] = [];
    if (settings.crl !== '') {
      const pem = files.read(settings.crl);
      if (pem === null) {
        return fail(`X509_LOOKUP_load_file("${settings.crl}") failed (SSL: ${fopenFailure(settings.crl)} `
          + 'error:05880002:x509 certificate routines::system lib)');
      }
      crls = crlsFromPem(pem);
    }
    const anchors = anchorsFromPem(...anchorTexts);
    const ocsp = settings.ocsp !== 'off' && wire
      ? {
        responder: new WireOcspResponder(new OcspClient(wire, {
          ...DEFAULT_OCSP_POLICY, responderUrl: settings.ocspResponder === '' ? null : settings.ocspResponder,
          overrideResponder: settings.ocspResponder !== '', trusted: anchors,
        })),
        scope: settings.ocsp === 'leaf' ? 'leaf' as const : 'chain' as const, missingOk: false,
      }
      : undefined;
    verifier = buildClientVerifier({
      anchors, crls, crlChecking: settings.crl !== '',
      revocationScope: 'chain', missingCrlOk: false, maxDepth: settings.verifyDepth, ocsp,
    });
  }

  let dhParameters: DhParameters | undefined;
  if (settings.dhparam !== '') {
    const pem = files.read(settings.dhparam);
    if (pem === null) return fail(`BIO_new_file("${settings.dhparam}") failed (SSL: ${fopenFailure(settings.dhparam)})`);
    const parsed = pemToDhParameters(pem);
    if (!parsed) {
      return fail(`PEM_read_bio_DHparams("${settings.dhparam}") failed `
        + '(SSL: error:0480006C:PEM routines::no start line:Expecting: DH PARAMETERS)');
    }
    dhParameters = parsed;
  }

  let groups: readonly string[] = DEFAULT_ECDH_GROUPS;
  if (settings.ecdhCurve !== 'auto') {
    const parsed = parseGroupList(settings.ecdhCurve);
    if (parsed.ok === false) {
      return fail(`SSL_CTX_set1_curves_list("${settings.ecdhCurve}") failed (SSL: ${parsed.error})`);
    }
    groups = parsed.groups;
  }

  let ticketKey: Uint8Array | undefined;
  if (settings.sessionTicketKeys.length > 0) {
    const path = settings.sessionTicketKeys[0];
    const text = files.read(path);
    if (text === null) return fail(`open() "${path}" failed (2: No such file or directory)`);
    if (text.length !== 48 && text.length !== 80) return fail(`"${path}" must be 48 or 80 bytes`);
    ticketKey = ticketKeyFromFile(text);
  }

  let staple: OcspStapleSource | undefined;
  const warnings: string[] = [];
  if (settings.stapling && settings.staplingFile !== '') {
    const pem = files.read(settings.staplingFile);
    if (pem === null) {
      return fail(`BIO_new_file("${settings.staplingFile}") failed (SSL: ${fopenFailure(settings.staplingFile)})`);
    }
    let parsed: OcspResponseMessage;
    try {
      parsed = decodeOcspResponse(binaryStringToBytes(pem));
    } catch {
      return fail(`d2i_OCSP_RESPONSE_bio("${settings.staplingFile}") failed `
        + '(SSL: error:0688010A:asn1 encoding routines::nested asn1 error)');
    }
    if (!parsed.singles.some((single) => sameSerial(single.certId.serialNumber, leafChain[0]?.serialNumber ?? ''))) {
      return fail(`"ssl_stapling_file" "${settings.staplingFile}" holds no response for the server certificate`);
    }
    staple = parsed;
  } else if (settings.stapling && wire) {
    const leaf = leafChain[0];
    const trustedText = settings.trustedCertificate === '' ? null : files.read(settings.trustedCertificate);
    const trusted = trustedText === null ? [] : anchorsFromPem(trustedText);
    const issuer = leafChain.slice(1).find((c) => c.subject === leaf.issuer) ?? trusted.find((c) => c.subject === leaf.issuer);
    const name = settings.certificates[0];
    const url = settings.staplingResponder !== '' ? settings.staplingResponder : ocspUrlOf(leaf);
    if (!issuer) {
      warnings.push(`"ssl_stapling" ignored, issuer certificate not found for certificate "${name}"`);
    } else if (url === null) {
      warnings.push(`"ssl_stapling" ignored, no OCSP responder URL in the certificate "${name}"`);
    } else if (parseOcspUrl(url) === null) {
      warnings.push(`"ssl_stapling" ignored, invalid URL prefix in OCSP responder "${url}" in the certificate "${name}"`);
    } else {
      const client = new OcspClient(wire, {
        ...DEFAULT_OCSP_POLICY, responderUrl: url, overrideResponder: true,
        trusted: [issuer, ...trusted], verifySignature: settings.staplingVerify, useNonce: false,
      });
      staple = (cert) => {
        const found = client.lookup(cert, issuer);
        return found.ok ? found.response : null;
      };
    }
  }

  const state = createSslConfState();
  for (const [command, value] of settings.confCommands) {
    const outcome = applySslConfCommand(state, command, value, { mode: 'file', server: true });
    if (outcome.ok === false) {
      return fail(`SSL_CONF_cmd("${command}", "${value}") failed (${formatSslConfError(outcome.errors)})`);
    }
  }
  let finalCipherList = cipherSource;
  let finalGroups = groups;
  if (state.cipherString !== null) {
    const override = resolveCipherList(state.cipherString);
    if (override.ok === false) {
      return fail(`SSL_CONF_cmd("CipherString", "${state.cipherString}") failed (SSL: ${override.error})`);
    }
    finalCipherList = state.cipherString;
  }
  if (state.groups !== null) finalGroups = state.groups;

  const baseProtocols = settings.protocols
    .map((name) => PROTOCOL_BY_NGINX_NAME[name])
    .filter((version): version is TlsProtocolVersion => version !== undefined);

  const sessionTickets = state.sessionTicket ?? settings.sessionTickets;
  const protocols = effectiveProtocols(baseProtocols, state);
  const preferServerCiphers = state.serverPreference ?? settings.preferServerCiphers;
  const tls13Ciphersuites = state.tls13Ciphersuites ?? undefined;
  const extendedMasterSecret = state.extendedMasterSecret ?? undefined;

  const fingerprint = [
    leafChain[0]?.serialNumber ?? '', leafChain[0]?.notAfter ?? '', key?.material ?? '', protocols.join(','), finalCipherList,
    preferServerCiphers, finalGroups.join(','), sessionTickets, settings.sessionTimeout,
    settings.sessionCache.builtin, settings.sessionCache.shared?.name ?? '', settings.earlyData,
    settings.bufferSize, settings.ocsp, settings.ocspResponder, settings.staplingResponder, settings.staplingVerify, settings.verifyClient, settings.verifyDepth, settings.rejectHandshake,
    ticketKey ? bytesToHexText(ticketKey) : '', typeof staple === 'object' ? staple.signature : staple ? 'dynamic' : '', tls13Ciphersuites ?? '',
    dhParameters ? dhParameters.prime.toString(16).slice(0, 16) : '', extendedMasterSecret ?? '',
  ].join('|');

  return {
    settings, identity: key ? { cert: leafChain[0], key, chain: leafChain.slice(1) } : null, verifier, protocols,
    cipherList: finalCipherList, tls13Ciphersuites, groups: finalGroups, preferServerCiphers,
    sessionTickets, extendedMasterSecret, ticketKey, staple, dhParameters, fingerprint, warnings,
  };
}

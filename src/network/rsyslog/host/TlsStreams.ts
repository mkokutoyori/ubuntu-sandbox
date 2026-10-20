import type { TcpSocket } from '@/network/tcp/TcpStack';
import type { Errno } from '@/network/core/Errno';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientChannel } from '@/network/tls/TlsClientChannel';
import { TlsServerChannel } from '@/network/tls/TlsServerChannel';
import { runTlsHandshakeOverSocket } from '@/network/http/https/TlsRecordWire';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { CertificateVerifier, type VerificationReason } from '@/network/pki/CertificateVerifier';
import type { CertificateRevocationList } from '@/network/pki/CertificateRevocationList';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import { privateKeyPairsWith } from '@/network/pki/keyPairing';
import { pemToCertChain, pemToPrivateKey } from '@/network/pki/pem';
import { encodeCertificate } from '@/network/pki/der/X509Der';
import { anchorsFromPem, crlsFromPem, ephemeralIdentity, type ServerIdentity } from '@/network/http/https/ServerTlsToolkit';
import { sha1, sha256 } from '@/crypto/hash';
import { bytesToHex } from '@/crypto/encoding';
import { RS_RET } from '../engine/Log';
import type { StreamConnection } from '../engine/Host';
import type { StreamTlsOptions } from '../engine/StreamDriver';
import { authorizePeer, type ChainVerdict, type PeerAuthPolicy, type PeerCertificateView } from '../engine/PeerAuth';

export interface TlsFileReader {
  read(path: string): string | null;
}

interface TlsMaterial {
  readonly identity: ServerIdentity | null;
  readonly verifier: CertificateVerifier;
  readonly crlNextUpdateMs: number | null;
}

const ENOENT: Errno = 'ENOENT';

function fingerprint(prefix: string, digest: Uint8Array): string {
  return `${prefix}${(bytesToHex(digest).toUpperCase().match(/.{2}/g) ?? []).map((pair) => `:${pair}`).join('')}`;
}

function commonNameOf(subject: string): string | null {
  const found = /(?:^|,)\s*CN=((?:\\.|[^,])*)/.exec(subject);
  return found === null ? null : found[1].replace(/\\(.)/g, '$1');
}

function readFileOrReport(path: string, files: TlsFileReader, options: StreamTlsOptions): string | null {
  const text = files.read(path);
  if (text === null) options.runtime.error(`can not read file '${path}'`, RS_RET.FILE_NOT_FOUND, ENOENT);
  return text;
}

function loadMaterial(options: StreamTlsOptions, files: TlsFileReader): TlsMaterial | null {
  const { runtime } = options;
  let identity: ServerIdentity | null = null;
  if (options.authMode !== 'anon') {
    if (options.certFile === null) runtime.error('warning: certificate file is not set', RS_RET.CERT_MISSING);
    if (options.keyFile === null) runtime.error('warning: key file is not set', RS_RET.CERTKEY_MISSING);
    if (options.certFile !== null && options.keyFile !== null) {
      const certText = readFileOrReport(options.certFile, files, options);
      const keyText = readFileOrReport(options.keyFile, files, options);
      if (certText === null || keyText === null) return null;
      const chain = pemToCertChain(certText);
      const key: PkiPrivateKey | null = pemToPrivateKey(keyText);
      if (chain.length === 0 || key === null || !privateKeyPairsWith(chain[0].publicKey, key)) {
        runtime.error(`error adding our certificate. GnuTLS error -64, message: 'Error while reading file.', key: '${options.keyFile}', cert: '${options.certFile}'`, RS_RET.GNUTLS_ERR);
        return null;
      }
      identity = { cert: chain[0], key, chain: chain.slice(1) };
    }
  }
  const anchorTexts: string[] = [];
  if (options.caFile === null) {
    if (options.authMode !== 'anon') runtime.error('Warning: CA certificate is not set', RS_RET.CA_CERT_MISSING);
  } else {
    for (const path of [options.caFile, ...(options.caExtraFiles === null ? [] : options.caExtraFiles.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''))]) {
      const text = files.read(path);
      if (text === null) {
        runtime.error(`error reading certificate file '${path}' - a common cause is that the file does not exist`, RS_RET.GNUTLS_ERR);
        return null;
      }
      anchorTexts.push(text);
    }
  }
  const anchors: X509Certificate[] = anchorsFromPem(...anchorTexts);
  let crls: CertificateRevocationList[] = [];
  if (options.crlFile !== null) {
    const text = files.read(options.crlFile);
    if (text === null) {
      runtime.error(`error reading CRL file '${options.crlFile}'`, RS_RET.GNUTLS_ERR);
      return null;
    }
    crls = crlsFromPem(text);
    if (crls.length === 0) {
      runtime.error(`error parsing Certificate revocation list (CRL) '${options.crlFile}'`, RS_RET.GNUTLS_ERR);
      return null;
    }
  }
  const verifier = new CertificateVerifier({
    trustAnchors: anchors, crls, revocationCheck: crls.length > 0 ? 'crl' : 'none',
    ...(options.verifyDepth === null ? {} : { maxDepth: options.verifyDepth }),
  });
  const nextUpdates = crls.map((crl) => crl.nextUpdate);
  return { identity, verifier, crlNextUpdateMs: nextUpdates.length === 0 ? null : Math.min(...nextUpdates) };
}

function verdictOf(reason: VerificationReason | undefined): ChainVerdict {
  switch (reason) {
    case undefined: return 'valid';
    case 'unknown': return 'signer-not-found';
    case 'expired': return 'expired';
    case 'revoked': return 'revoked';
    case 'not-a-ca': return 'signer-not-ca';
    case 'weak-key': case 'weak-ca-key': return 'insecure-algorithm';
    case 'purpose': case 'key-usage': return 'purpose-mismatch';
    default: return 'invalid';
  }
}

function peerView(
  leaf: X509Certificate | null, chain: readonly X509Certificate[], material: TlsMaterial, options: StreamTlsOptions,
): PeerCertificateView | null {
  if (leaf === null) return null;
  const der = encodeCertificate(leaf);
  const san = leaf.extensions?.subjectAltName ?? [];
  const purpose = options.checkExtendedKeyPurpose ? (options.role === 'client' ? 'serverAuth' : 'clientAuth') : undefined;
  const result = material.verifier.verify(leaf, undefined, chain.slice(1), purpose);
  return {
    fingerprintSha1: fingerprint('SHA1', sha1(der)),
    fingerprintSha256: fingerprint('SHA256', sha256(der)),
    dnsNames: san.filter((entry) => entry.startsWith('DNS:')).map((entry) => entry.slice(4)),
    ipAddresses: san.filter((entry) => entry.startsWith('IP:')).map((entry) => entry.slice(3)),
    commonName: commonNameOf(leaf.subject),
    chain: verdictOf(result.reason),
    activationTimesMs: (chain.length > 0 ? chain : [leaf]).map((certificate) => certificate.notBefore),
    description: `peer provided ${Math.max(chain.length, 1)} certificate(s). Subject: ${leaf.subject}; issuer: ${leaf.issuer}`,
  };
}

function policyOf(options: StreamTlsOptions, material: TlsMaterial): PeerAuthPolicy {
  return {
    authMode: options.authMode, permittedPeers: options.permittedPeers, connectHost: options.connectHost,
    permitExpiredCerts: options.permitExpired, prioritizeSan: options.prioritizeSan, crlNextUpdateMs: material.crlNextUpdateMs,
  };
}

export interface TlsClock {
  nowMs(): number;
}

export function openTlsClient(
  socket: TcpSocket, options: StreamTlsOptions, files: TlsFileReader, clock: TlsClock,
): StreamConnection | { readonly errno: Errno } {
  const material = loadMaterial(options, files);
  if (material === null) {
    socket.close();
    return { errno: 'EPROTO' };
  }
  const tls = new TlsClientSession({
    verifier: material.verifier, allowUntrustedPeer: true,
    ...(options.remoteSni !== null || options.connectHost !== null ? { serverName: options.remoteSni ?? options.connectHost ?? undefined } : {}),
    ...(material.identity === null ? {} : { clientCert: material.identity.cert, clientChain: material.identity.chain, clientPrivateKey: material.identity.key }),
  });
  const trailing: TlsRecord[] = [];
  runTlsHandshakeOverSocket(socket, tls, (records) => { trailing.push(...records); });
  if (tls.result !== 'success') {
    options.runtime.error(`TLS handshake failed with ${options.connectHost ?? socket.remoteIp}`, RS_RET.TLS_HANDSHAKE_ERR);
    socket.close();
    return { errno: 'EPROTO' };
  }
  const chain = tls.peerCertificateChain.length > 0 ? tls.peerCertificateChain : tls.peerCertificate === null ? [] : [tls.peerCertificate];
  const code = authorizePeer(
    policyOf(options, material), peerView(tls.peerCertificate, chain, material, options),
    { runtime: options.runtime, nowMs: clock.nowMs(), remoteName: options.connectHost ?? socket.remoteIp, reportAuthError: true },
  );
  if (code !== RS_RET.NO_ERRCODE) {
    socket.close();
    return { errno: 'EPROTO' };
  }
  const channel = new TlsClientChannel(socket, tls);
  if (trailing.length > 0) channel.receiveRecords(trailing);
  return secureConnection(socket, (bytes) => channel.send(bytes), (handler) => channel.onPush((text) => handler(Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff))));
}

function secureConnection(
  socket: TcpSocket, send: (bytes: Uint8Array) => void, subscribe: (handler: (bytes: Uint8Array) => void) => void,
): StreamConnection {
  let closeHandler: (() => void) | null = null;
  let finished = false;
  let peerClosed = false;
  socket.onEnd(() => {
    peerClosed = true;
    closeHandler?.();
  });
  socket.onClose(() => {
    finished = true;
    closeHandler?.();
  });
  return {
    remoteIp: socket.remoteIp,
    remotePort: socket.remotePort,
    get closedByPeer(): boolean { return peerClosed; },
    write(bytes: Uint8Array): Errno | null {
      if (finished || socket.closed) return 'EPIPE';
      send(bytes);
      return null;
    },
    close(): void { socket.close(); },
    onData(handler: (bytes: Uint8Array) => void): void { subscribe(handler); },
    onClose(handler: () => void): void {
      closeHandler = handler;
      if (finished || peerClosed) handler();
    },
  };
}

export function acceptTlsServer(
  socket: TcpSocket, options: StreamTlsOptions, files: TlsFileReader, clock: TlsClock, onReady: (connection: StreamConnection) => void,
): void {
  const material = loadMaterial(options, files);
  if (material === null) {
    socket.close();
    return;
  }
  const identity = material.identity ?? ephemeralIdentity();
  const session = new TlsServerSession({
    serverCert: identity.cert, serverPrivateKey: identity.key, serverChain: identity.chain,
    ...(options.authMode === 'anon' ? {} : { requestClientCert: true, verifier: material.verifier, clientCertPolicy: 'lenient' as const }),
  });
  let subscriber: ((bytes: Uint8Array) => void) | null = null;
  const buffered: Uint8Array[] = [];
  let channel: TlsServerChannel | null = null;
  channel = new TlsServerChannel(socket, session, {
    onHandshakeComplete: () => {
      const chain = session.peerCertificateChain.length > 0 ? session.peerCertificateChain : session.peerCertificate === null ? [] : [session.peerCertificate];
      const code = authorizePeer(
        policyOf(options, material), peerView(session.peerCertificate, chain, material, options),
        { runtime: options.runtime, nowMs: clock.nowMs(), remoteName: socket.remoteIp, reportAuthError: true },
      );
      if (code !== RS_RET.NO_ERRCODE) {
        channel?.close();
        return;
      }
      const secure = secureConnection(socket, (bytes) => channel?.write(bytes), (handler) => {
        subscriber = handler;
        for (const chunk of buffered.splice(0)) handler(chunk);
      });
      onReady(secure);
    },
    onData: (plaintext) => {
      if (subscriber === null) buffered.push(plaintext);
      else subscriber(plaintext);
    },
  });
}

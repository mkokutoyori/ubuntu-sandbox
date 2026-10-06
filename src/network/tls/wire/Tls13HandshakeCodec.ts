import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@/crypto/encoding';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { OcspResponseMessage } from '@/network/pki/OcspWire';
import { encodeOcspResponse, decodeOcspResponse } from '@/network/pki/der/OcspDer';
import { encodeCertificate, decodeCertificate } from '@/network/pki/der/X509Der';
import { der, children, parseDer, integerMagnitude, unsignedIntegerBytes, concatBytes } from '@/network/pki/der/Asn1';
import { HELLO_RETRY_REQUEST_RANDOM } from '../types';
import type {
  ClientHello, ServerHello, HelloRetryRequest, EncryptedExtensionsMessage, CertificateRequest,
  CertificateMessage, CertificateVerify, Finished, NewSessionTicket, KeyUpdate, TlsHandshakeMessage,
  LegacyClientExtensions,
} from '../messages';
import { TlsReader, TlsWriter, TlsDecodeError } from './TlsBytes';
import {
  EXTENSION, HANDSHAKE_TYPE, cipherSuiteCode, cipherSuiteFromCode, groupCode, groupName,
  signatureSchemeCode, signatureSchemeName, versionCode, versionName, pskModeCode, pskModeName,
  isGreaseCode, maxFragmentLengthCode, maxFragmentLengthBytes, isTls13CipherSuiteCode, GREASE_CIPHER_SUITE_NAME,
} from './TlsRegistry';

const LEGACY_VERSION_TLS12 = 0x0303;
const PSK_BINDER_LENGTH = 32;
const EMPTY_RENEGOTIATION_INFO_SCSV = 0x00ff;
const EARLY_DATA_TICKET_LIMIT = 0x4000;

function extension(writer: TlsWriter, type: number, fill: (body: TlsWriter) => void): void {
  writer.u16(type).vector(2, fill);
}

function handshake(type: number, fill: (body: TlsWriter) => void): Uint8Array {
  const writer = new TlsWriter();
  writer.u8(type).vector(3, fill);
  return writer.toBytes();
}

function keyShareEntry(share: string): { group: number; key: string } {
  const colon = share.indexOf(':');
  return { group: groupCode(share.slice(0, colon)), key: share.slice(colon + 1) };
}

function writeKeyShareEntry(body: TlsWriter, share: string): void {
  const { group, key } = keyShareEntry(share);
  body.u16(group).vector(2, (inner) => inner.hex(key));
}

function readKeyShareEntry(reader: TlsReader): string {
  const group = groupName(reader.u16());
  const key = reader.vector(2).rest();
  return `${group}:${bytesToHex(key)}`;
}

function protocolBytes(name: string): Uint8Array {
  const grease = /^grease_([0-9a-f]{4})$/.exec(name);
  return grease ? hexToBytes(grease[1]) : utf8ToBytes(name);
}

function protocolName(bytes: Uint8Array): string {
  if (bytes.length === 2 && isGreaseCode((bytes[0] << 8) | bytes[1])) return `grease_${bytesToHex(bytes)}`;
  return bytesToUtf8(bytes);
}

function eachExtension(reader: TlsReader, visit: (type: number, body: TlsReader) => void): void {
  while (!reader.done) {
    const type = reader.u16();
    visit(type, reader.vector(2));
  }
}

export function encodeClientHello(hello: ClientHello): Uint8Array {
  const legacy = hello.legacyExtensions;
  return handshake(HANDSHAKE_TYPE.clientHello, (body) => {
    body.u16(versionCode(hello.legacyVersion)).hex(hello.random);
    body.vector(1, (inner) => inner.hex(legacy?.sessionId ?? ''));
    const suites: number[] = hello.cipherSuites.map(cipherSuiteCode);
    for (const code of hello.legacyCipherSuites ?? []) if (!(code === 0x0a0a && suites.includes(0x0a0a))) suites.push(code);
    body.vector(2, (inner) => { for (const code of suites) inner.u16(code); });
    body.vector(1, (inner) => inner.u8(0));
    body.vector(2, (inner) => {
      const ext = hello.extensions;
      if (ext.serverName !== undefined) {
        extension(inner, EXTENSION.serverName, (e) => e.vector(2, (list) => list.u8(0).vector(2, (name) => name.bytes(utf8ToBytes(ext.serverName!)))));
      }
      if (ext.maxFragmentLength !== undefined) {
        extension(inner, EXTENSION.maxFragmentLength, (e) => e.u8(maxFragmentLengthCode(ext.maxFragmentLength!)));
      }
      if (ext.statusRequest) extension(inner, EXTENSION.statusRequest, (e) => e.u8(1).vector(2, () => undefined).vector(2, () => undefined));
      extension(inner, EXTENSION.supportedGroups, (e) => e.vector(2, (list) => { for (const name of ext.supportedGroups) list.u16(groupCode(name)); }));
      if (legacy !== undefined) extension(inner, EXTENSION.ecPointFormats, (e) => e.vector(1, (list) => list.u8(0)));
      extension(inner, EXTENSION.signatureAlgorithms, (e) => e.vector(2, (list) => { for (const name of ext.signatureAlgorithms) list.u16(signatureSchemeCode(name)); }));
      if (ext.alpn !== undefined) {
        extension(inner, EXTENSION.alpn, (e) => e.vector(2, (list) => { for (const name of ext.alpn!) list.vector(1, (entry) => entry.bytes(protocolBytes(name))); }));
      }
      if (legacy?.extendedMasterSecret) extension(inner, EXTENSION.extendedMasterSecret, () => undefined);
      if (legacy?.renegotiationInfo !== null && legacy?.renegotiationInfo !== undefined) {
        extension(inner, EXTENSION.renegotiationInfo, (e) => e.vector(1, (data) => data.hex(legacy.renegotiationInfo!)));
      }
      if (legacy?.sessionTicket !== null && legacy?.sessionTicket !== undefined) {
        extension(inner, EXTENSION.sessionTicket, (e) => e.hex(legacy.sessionTicket!));
      }
      if (ext.supportedVersions.length > 0) {
        extension(inner, EXTENSION.supportedVersions, (e) => e.vector(1, (list) => { for (const name of ext.supportedVersions) list.u16(versionCode(name)); }));
      }
      if (ext.pskKeyExchangeModes !== undefined) {
        extension(inner, EXTENSION.pskKeyExchangeModes, (e) => e.vector(1, (list) => { for (const name of ext.pskKeyExchangeModes!) list.u8(pskModeCode(name)); }));
      }
      if (ext.keyShare !== undefined && ext.supportedVersions.length > 0) {
        extension(inner, EXTENSION.keyShare, (e) => e.vector(2, (list) => { if (ext.keyShare !== '') writeKeyShareEntry(list, ext.keyShare); }));
      }
      if (ext.earlyData) extension(inner, EXTENSION.earlyData, () => undefined);
      if (ext.preSharedKey !== undefined) {
        extension(inner, EXTENSION.preSharedKey, (e) => {
          e.vector(2, (identities) => identities.vector(2, (identity) => identity.hex(ext.preSharedKey!)).u32(0));
          e.vector(2, (binders) => binders.vector(1, (binder) => binder.bytes(new Uint8Array(PSK_BINDER_LENGTH))));
        });
      }
    });
  });
}

export function decodeClientHello(reader: TlsReader): ClientHello {
  const legacyVersion = versionName(reader.u16());
  const random = reader.hex(32);
  const sessionId = reader.vector(1).rest();
  const suiteReader = reader.vector(2);
  const cipherSuites: string[] = [];
  const legacyCipherSuites: number[] = [];
  while (!suiteReader.done) {
    const code = suiteReader.u16();
    if (isTls13CipherSuiteCode(code) || code === 0x0a0a) cipherSuites.push(cipherSuiteFromCode(code));
    if (!isTls13CipherSuiteCode(code)) legacyCipherSuites.push(code);
  }
  reader.vector(1);
  let supportedVersions: string[] = [];
  let keyShare = '';
  let supportedGroups: string[] = [];
  let signatureAlgorithms: string[] = [];
  let serverName: string | undefined;
  let statusRequest: boolean | undefined;
  let maxFragmentLength: number | undefined;
  let alpn: string[] | undefined;
  let pskKeyExchangeModes: string[] | undefined;
  let preSharedKey: string | undefined;
  let earlyData: boolean | undefined;
  let extendedMasterSecret = false;
  let renegotiationInfo: string | null = null;
  let sessionTicket: string | null = null;
  if (!reader.done) {
    eachExtension(reader.vector(2), (type, body) => {
      switch (type) {
        case EXTENSION.serverName: {
          const list = body.vector(2);
          while (!list.done) {
            const nameType = list.u8();
            const name = list.vector(2).rest();
            if (nameType === 0) serverName = bytesToUtf8(name);
          }
          break;
        }
        case EXTENSION.maxFragmentLength: maxFragmentLength = maxFragmentLengthBytes(body.u8()); break;
        case EXTENSION.statusRequest: statusRequest = body.u8() === 1; break;
        case EXTENSION.supportedGroups: {
          const list = body.vector(2);
          while (!list.done) supportedGroups.push(groupName(list.u16()));
          break;
        }
        case EXTENSION.signatureAlgorithms: {
          const list = body.vector(2);
          while (!list.done) signatureAlgorithms.push(signatureSchemeName(list.u16()));
          break;
        }
        case EXTENSION.alpn: {
          alpn = [];
          const list = body.vector(2);
          while (!list.done) alpn.push(protocolName(list.vector(1).rest()));
          break;
        }
        case EXTENSION.extendedMasterSecret: extendedMasterSecret = true; break;
        case EXTENSION.renegotiationInfo: renegotiationInfo = bytesToHex(body.vector(1).rest()); break;
        case EXTENSION.sessionTicket: sessionTicket = bytesToHex(body.rest()); break;
        case EXTENSION.supportedVersions: {
          const list = body.vector(1);
          while (!list.done) supportedVersions.push(versionName(list.u16()));
          break;
        }
        case EXTENSION.pskKeyExchangeModes: {
          pskKeyExchangeModes = [];
          const list = body.vector(1);
          while (!list.done) pskKeyExchangeModes.push(pskModeName(list.u8()));
          break;
        }
        case EXTENSION.keyShare: {
          const list = body.vector(2);
          if (!list.done) keyShare = readKeyShareEntry(list);
          break;
        }
        case EXTENSION.earlyData: earlyData = true; break;
        case EXTENSION.preSharedKey: {
          const identities = body.vector(2);
          preSharedKey = bytesToHex(identities.vector(2).rest());
          break;
        }
        default: break;
      }
    });
  }
  if (renegotiationInfo === null && legacyCipherSuites.includes(EMPTY_RENEGOTIATION_INFO_SCSV)) renegotiationInfo = '';
  const legacyExtensions: LegacyClientExtensions | undefined =
    sessionId.length > 0 || extendedMasterSecret || renegotiationInfo !== null || sessionTicket !== null
      ? { sessionId: bytesToHex(sessionId), extendedMasterSecret, renegotiationInfo, sessionTicket }
      : undefined;
  const hello: ClientHello = {
    kind: 'client_hello', legacyVersion, random, cipherSuites: cipherSuites as ClientHello['cipherSuites'],
    ...(legacyCipherSuites.length > 0 ? { legacyCipherSuites } : {}),
    ...(legacyExtensions ? { legacyExtensions } : {}),
    extensions: {
      supportedVersions, keyShare, supportedGroups, signatureAlgorithms,
      ...(serverName !== undefined ? { serverName } : {}),
      ...(statusRequest !== undefined ? { statusRequest } : {}),
      ...(maxFragmentLength !== undefined ? { maxFragmentLength } : {}),
      ...(alpn !== undefined ? { alpn } : {}),
      ...(pskKeyExchangeModes !== undefined ? { pskKeyExchangeModes } : {}),
      ...(preSharedKey !== undefined ? { preSharedKey } : {}),
      ...(earlyData !== undefined ? { earlyData } : {}),
    },
  };
  return hello;
}

export function encodeServerHello(hello: ServerHello): Uint8Array {
  return handshake(HANDSHAKE_TYPE.serverHello, (body) => {
    body.u16(LEGACY_VERSION_TLS12).hex(hello.random);
    body.vector(1, (inner) => inner.hex(hello.sessionIdEcho ?? ''));
    body.u16(cipherSuiteCode(hello.cipherSuite)).u8(0);
    body.vector(2, (inner) => {
      extension(inner, EXTENSION.supportedVersions, (e) => e.u16(versionCode(hello.extensions.supportedVersions)));
      if (hello.extensions.keyShare !== undefined) extension(inner, EXTENSION.keyShare, (e) => writeKeyShareEntry(e, hello.extensions.keyShare!));
      if (hello.extensions.preSharedKey !== undefined) extension(inner, EXTENSION.preSharedKey, (e) => e.u16(0));
    });
  });
}

export function encodeHelloRetryRequest(hello: HelloRetryRequest): Uint8Array {
  return handshake(HANDSHAKE_TYPE.serverHello, (body) => {
    body.u16(LEGACY_VERSION_TLS12).hex(HELLO_RETRY_REQUEST_RANDOM);
    body.vector(1, (inner) => inner.hex(hello.sessionIdEcho ?? ''));
    body.u16(cipherSuiteCode(hello.cipherSuite ?? 'TLS_AES_128_GCM_SHA256')).u8(0);
    body.vector(2, (inner) => {
      extension(inner, EXTENSION.supportedVersions, (e) => e.u16(versionCode('1.3')));
      extension(inner, EXTENSION.keyShare, (e) => e.u16(groupCode(hello.selectedGroup)));
    });
  });
}

export function decodeServerHello(reader: TlsReader): ServerHello | HelloRetryRequest {
  reader.u16();
  const random = reader.hex(32);
  const sessionIdEcho = bytesToHex(reader.vector(1).rest());
  const cipherSuite = cipherSuiteFromCode(reader.u16());
  reader.u8();
  let supportedVersions = '';
  let keyShare: string | undefined;
  let selectedGroup: string | undefined;
  let preSharedKey: string | undefined;
  eachExtension(reader.vector(2), (type, body) => {
    if (type === EXTENSION.supportedVersions) supportedVersions = versionName(body.u16());
    else if (type === EXTENSION.keyShare) {
      if (body.remaining === 2) selectedGroup = groupName(body.u16());
      else keyShare = readKeyShareEntry(body);
    } else if (type === EXTENSION.preSharedKey) {
      body.u16();
      preSharedKey = 'accepted';
    }
  });
  if (random === HELLO_RETRY_REQUEST_RANDOM) {
    return {
      kind: 'hello_retry_request', random: HELLO_RETRY_REQUEST_RANDOM, selectedGroup: selectedGroup ?? '', cipherSuite,
      ...(sessionIdEcho !== '' ? { sessionIdEcho } : {}),
    };
  }
  return {
    kind: 'server_hello', random, cipherSuite,
    ...(sessionIdEcho !== '' ? { sessionIdEcho } : {}),
    extensions: {
      supportedVersions,
      ...(keyShare !== undefined ? { keyShare } : {}),
      ...(preSharedKey !== undefined ? { preSharedKey } : {}),
    },
  };
}

export function encodeEncryptedExtensions(message: EncryptedExtensionsMessage): Uint8Array {
  return handshake(HANDSHAKE_TYPE.encryptedExtensions, (body) => body.vector(2, (inner) => {
    const ext = message.extensions;
    if (ext.maxFragmentLength !== undefined) extension(inner, EXTENSION.maxFragmentLength, (e) => e.u8(maxFragmentLengthCode(ext.maxFragmentLength!)));
    if (ext.alpn !== undefined) extension(inner, EXTENSION.alpn, (e) => e.vector(2, (list) => list.vector(1, (name) => name.bytes(protocolBytes(ext.alpn!)))));
    if (ext.earlyData) extension(inner, EXTENSION.earlyData, () => undefined);
  }));
}

export function decodeEncryptedExtensions(reader: TlsReader): EncryptedExtensionsMessage {
  const extensions: { alpn?: string; earlyData?: boolean; maxFragmentLength?: number } = {};
  eachExtension(reader.vector(2), (type, body) => {
    if (type === EXTENSION.alpn) extensions.alpn = protocolName(body.vector(2).vector(1).rest());
    else if (type === EXTENSION.earlyData) extensions.earlyData = true;
    else if (type === EXTENSION.maxFragmentLength) extensions.maxFragmentLength = maxFragmentLengthBytes(body.u8());
  });
  return { kind: 'encrypted_extensions', extensions };
}

export function encodeCertificateRequest(message: CertificateRequest): Uint8Array {
  return handshake(HANDSHAKE_TYPE.certificateRequest, (body) => {
    body.vector(1, (inner) => inner.hex(message.certificateRequestContext));
    body.vector(2, (inner) => extension(inner, EXTENSION.signatureAlgorithms, (e) => e.vector(2, (list) => {
      for (const name of message.signatureAlgorithms) list.u16(signatureSchemeCode(name));
    })));
  });
}

export function decodeCertificateRequest(reader: TlsReader): CertificateRequest {
  const certificateRequestContext = bytesToHex(reader.vector(1).rest());
  const signatureAlgorithms: string[] = [];
  eachExtension(reader.vector(2), (type, body) => {
    if (type !== EXTENSION.signatureAlgorithms) return;
    const list = body.vector(2);
    while (!list.done) signatureAlgorithms.push(signatureSchemeName(list.u16()));
  });
  return { kind: 'certificate_request', certificateRequestContext, signatureAlgorithms };
}

export function encodeCertificateMessage(message: CertificateMessage): Uint8Array {
  return handshake(HANDSHAKE_TYPE.certificate, (body) => {
    body.vector(1, () => undefined);
    body.vector(3, (list) => {
      message.certificateList.forEach((cert, index) => {
        list.vector(3, (data) => data.bytes(encodeCertificate(cert)));
        list.vector(2, (extensions) => {
          if (index === 0 && message.ocspStaple !== undefined) {
            extension(extensions, EXTENSION.statusRequest, (e) => e.u8(1).vector(3, (response) => response.bytes(encodeOcspResponse(message.ocspStaple))));
          }
        });
      });
    });
  });
}

export function decodeCertificateMessage(reader: TlsReader): CertificateMessage {
  reader.vector(1);
  const list = reader.vector(3);
  const certificateList: X509Certificate[] = [];
  let ocspStaple: OcspResponseMessage | undefined;
  while (!list.done) {
    certificateList.push(decodeCertificate(list.vector(3).rest()));
    eachExtension(list.vector(2), (type, body) => {
      if (type === EXTENSION.statusRequest && certificateList.length === 1 && body.u8() === 1) {
        ocspStaple = decodeOcspResponse(body.vector(3).rest());
      }
    });
  }
  return { kind: 'certificate', certificateList, ...(ocspStaple !== undefined ? { ocspStaple } : {}) };
}

function ecdsaSignatureToDer(signature: string): Uint8Array {
  const raw = hexToBytes(signature.slice('ecdsa:'.length));
  return der.sequence(unsignedIntegerBytes(raw.slice(0, 32)), unsignedIntegerBytes(raw.slice(32)));
}

function ecdsaSignatureFromDer(bytes: Uint8Array): string {
  const [r, s] = children(parseDer(bytes));
  const pad = (value: Uint8Array): Uint8Array => concatBytes([new Uint8Array(32 - value.length), value]);
  return `ecdsa:${bytesToHex(pad(integerMagnitude(r)))}${bytesToHex(pad(integerMagnitude(s)))}`;
}

export function encodeCertificateVerify(message: CertificateVerify): Uint8Array {
  const scheme = message.signatureAlgorithm ?? 'rsa_pss_rsae_sha256';
  return handshake(HANDSHAKE_TYPE.certificateVerify, (body) => {
    body.u16(signatureSchemeCode(scheme));
    body.vector(2, (inner) => inner.bytes(message.signature.startsWith('ecdsa:') ? ecdsaSignatureToDer(message.signature) : hexToBytes(message.signature)));
  });
}

export function decodeCertificateVerify(reader: TlsReader): CertificateVerify {
  const signatureAlgorithm = signatureSchemeName(reader.u16());
  const signature = reader.vector(2).rest();
  return {
    kind: 'certificate_verify', signatureAlgorithm,
    signature: signatureAlgorithm.startsWith('ecdsa_') ? ecdsaSignatureFromDer(signature) : bytesToHex(signature),
  };
}

export function encodeFinished(message: Finished): Uint8Array {
  return handshake(HANDSHAKE_TYPE.finished, (body) => body.hex(message.verifyData));
}

export function decodeFinished(reader: TlsReader): Finished {
  return { kind: 'finished', verifyData: bytesToHex(reader.rest()) };
}

export function encodeNewSessionTicket(message: NewSessionTicket): Uint8Array {
  return handshake(HANDSHAKE_TYPE.newSessionTicket, (body) => {
    body.u32(message.ticketLifetime).hex(message.ticketAgeAdd);
    body.vector(1, (inner) => inner.hex(message.ticketNonce));
    body.vector(2, (inner) => inner.hex(message.ticket));
    body.vector(2, (inner) => {
      if (message.extensions.earlyData) extension(inner, EXTENSION.earlyData, (e) => e.u32(EARLY_DATA_TICKET_LIMIT));
    });
  });
}

export function decodeNewSessionTicket(reader: TlsReader): NewSessionTicket {
  const ticketLifetime = reader.u32();
  const ticketAgeAdd = reader.hex(4);
  const ticketNonce = bytesToHex(reader.vector(1).rest());
  const ticket = bytesToHex(reader.vector(2).rest());
  let earlyData: boolean | undefined;
  eachExtension(reader.vector(2), (type) => { if (type === EXTENSION.earlyData) earlyData = true; });
  return {
    kind: 'new_session_ticket', ticketLifetime, ticketAgeAdd, ticketNonce, ticket,
    extensions: earlyData ? { earlyData } : {},
  };
}

export function encodeKeyUpdate(message: KeyUpdate): Uint8Array {
  return handshake(HANDSHAKE_TYPE.keyUpdate, (body) => body.u8(message.requestUpdate ? 1 : 0));
}

export function decodeKeyUpdate(reader: TlsReader): KeyUpdate {
  return { kind: 'key_update', requestUpdate: reader.u8() === 1 };
}

export function encodeTls13Message(message: TlsHandshakeMessage): Uint8Array {
  switch (message.kind) {
    case 'client_hello': return encodeClientHello(message);
    case 'server_hello': return encodeServerHello(message);
    case 'hello_retry_request': return encodeHelloRetryRequest(message);
    case 'encrypted_extensions': return encodeEncryptedExtensions(message);
    case 'certificate_request': return encodeCertificateRequest(message);
    case 'certificate': return encodeCertificateMessage(message);
    case 'certificate_verify': return encodeCertificateVerify(message);
    case 'finished': return encodeFinished(message);
    case 'new_session_ticket': return encodeNewSessionTicket(message);
    case 'key_update': return encodeKeyUpdate(message);
  }
}

export function decodeTls13Message(type: number, body: TlsReader): TlsHandshakeMessage {
  switch (type) {
    case HANDSHAKE_TYPE.clientHello: return decodeClientHello(body);
    case HANDSHAKE_TYPE.serverHello: return decodeServerHello(body);
    case HANDSHAKE_TYPE.encryptedExtensions: return decodeEncryptedExtensions(body);
    case HANDSHAKE_TYPE.certificateRequest: return decodeCertificateRequest(body);
    case HANDSHAKE_TYPE.certificate: return decodeCertificateMessage(body);
    case HANDSHAKE_TYPE.certificateVerify: return decodeCertificateVerify(body);
    case HANDSHAKE_TYPE.finished: return decodeFinished(body);
    case HANDSHAKE_TYPE.newSessionTicket: return decodeNewSessionTicket(body);
    case HANDSHAKE_TYPE.keyUpdate: return decodeKeyUpdate(body);
    default: throw new TlsDecodeError(`unsupported handshake type ${type}`);
  }
}

export function splitHandshakeMessages(bytes: Uint8Array): { type: number; body: TlsReader; raw: Uint8Array }[] {
  const out: { type: number; body: TlsReader; raw: Uint8Array }[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) throw new TlsDecodeError('truncated handshake header');
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (bytes.length - offset - 4 < length) throw new TlsDecodeError('truncated handshake message');
    out.push({ type: bytes[offset], body: new TlsReader(bytes.slice(offset + 4, offset + 4 + length)), raw: bytes.slice(offset, offset + 4 + length) });
    offset += 4 + length;
  }
  return out;
}

export { GREASE_CIPHER_SUITE_NAME };

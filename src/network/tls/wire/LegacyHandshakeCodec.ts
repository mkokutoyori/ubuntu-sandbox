import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@/crypto/encoding';
import { encodeCertificate, decodeCertificate } from '@/network/pki/der/X509Der';
import { der, children, parseDer, integerMagnitude, unsignedIntegerBytes, concatBytes } from '@/network/pki/der/Asn1';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { SignedOcspResponse } from '@/network/pki/OcspResponder';
import {
  PROTOCOL_VERSION_WIRE, legacySuiteByCode, legacySuiteByName, type KeyExchangeKind, type LegacyVersion,
} from '../legacy/legacyCipherSuites';
import type {
  ClientKeyExchange, KeyExchangeParams, LegacyCertificate, LegacyCertificateRequest, LegacyCertificateStatus,
  LegacyCertificateVerify, LegacyFinished, LegacyNewSessionTicket, LegacyServerHello, ServerHelloDone,
  ServerKeyExchange,
} from '../legacy/legacyMessages';
import { TlsReader, TlsWriter, TlsDecodeError } from './TlsBytes';
import {
  EXTENSION, HANDSHAKE_TYPE, groupCode, groupName, signatureSchemeCode, signatureSchemeName, versionName,
} from './TlsRegistry';
import { splitHandshakeMessages } from './Tls13HandshakeCodec';

export interface LegacyWireContext {
  readonly version?: LegacyVersion;
  readonly keyExchange?: KeyExchangeKind;
  readonly group?: string;
}

type Message = object;

const CURVE_TYPE_NAMED = 3;
const CERTIFICATE_TYPES: Readonly<Record<string, number>> = { rsa_sign: 1, dss_sign: 2, rsa_fixed_dh: 3, dss_fixed_dh: 4, ecdsa_sign: 64 };
const EC_POINT_FORMATS: Readonly<Record<string, number>> = { uncompressed: 0, ansiX962_compressed_prime: 1, ansiX962_compressed_char2: 2 };
const OCSP_STATUS_TYPE = 1;

function shareBody(share: string): string {
  return share.slice(share.indexOf(':') + 1);
}

function evenHex(value: string): string {
  return value.length % 2 === 1 ? `0${value}` : value;
}

function handshake(type: number, fill: (body: TlsWriter) => void): Uint8Array {
  return new TlsWriter().u8(type).vector(3, fill).toBytes();
}

function extension(writer: TlsWriter, type: number, fill: (body: TlsWriter) => void): void {
  writer.u16(type).vector(2, fill);
}

function nameForCode(table: Readonly<Record<string, number>>, code: number): string {
  return Object.entries(table).find(([, value]) => value === code)?.[0] ?? `code_${code.toString(16)}`;
}

function signatureBytes(signature: string): Uint8Array {
  if (!signature.startsWith('ecdsa:')) return hexToBytes(signature);
  const raw = hexToBytes(signature.slice('ecdsa:'.length));
  return der.sequence(unsignedIntegerBytes(raw.slice(0, 32)), unsignedIntegerBytes(raw.slice(32)));
}

function signatureText(bytes: Uint8Array, ecdsa: boolean): string {
  if (!ecdsa) return bytesToHex(bytes);
  const [r, s] = children(parseDer(bytes));
  const pad = (value: Uint8Array): Uint8Array => concatBytes([new Uint8Array(32 - value.length), value]);
  return `ecdsa:${bytesToHex(pad(integerMagnitude(r)))}${bytesToHex(pad(integerMagnitude(s)))}`;
}

function isEcdsaKeyExchange(keyExchange: KeyExchangeKind | undefined): boolean {
  return keyExchange === 'ECDHE_ECDSA';
}

export function serverKeyExchangeParametersBytes(params: KeyExchangeParams): Uint8Array {
  const writer = new TlsWriter();
  if (params.type === 'ecdh') {
    writer.u8(CURVE_TYPE_NAMED).u16(groupCode(params.group)).vector(1, (point) => point.hex(shareBody(params.publicKey)));
  } else {
    writer.vector(2, (p) => p.hex(evenHex(params.p)));
    writer.vector(2, (g) => g.hex(evenHex(params.g)));
    writer.vector(2, (ys) => ys.hex(evenHex(params.ys)));
  }
  return writer.toBytes();
}

export function encodeLegacyMessage(message: Message, context: LegacyWireContext = {}): Uint8Array {
  const kind = (message as { kind: string }).kind;
  switch (kind) {
    case 'legacy_server_hello': {
      const hello = message as LegacyServerHello;
      const definition = legacySuiteByName(hello.cipherSuite);
      if (definition === undefined) throw new TlsDecodeError(`no wire code for suite ${hello.cipherSuite}`);
      return handshake(HANDSHAKE_TYPE.serverHello, (body) => {
        body.u16(PROTOCOL_VERSION_WIRE[hello.version]).hex(hello.random);
        body.vector(1, (id) => id.hex(hello.sessionId));
        body.u16(definition.code).u8(0);
        body.vector(2, (extensions) => {
          const ext = hello.extensions;
          if (ext.maxFragmentLength !== undefined) extension(extensions, EXTENSION.maxFragmentLength, (e) => e.u8([512, 1024, 2048, 4096].indexOf(ext.maxFragmentLength!) + 1));
          if (ext.statusRequest) extension(extensions, EXTENSION.statusRequest, () => undefined);
          if (ext.ecPointFormats !== undefined) extension(extensions, EXTENSION.ecPointFormats, (e) => e.vector(1, (list) => { for (const name of ext.ecPointFormats!) list.u8(EC_POINT_FORMATS[name] ?? 0); }));
          if (ext.alpn !== undefined) extension(extensions, EXTENSION.alpn, (e) => e.vector(2, (list) => list.vector(1, (name) => name.bytes(utf8ToBytes(ext.alpn!)))));
          if (ext.extendedMasterSecret) extension(extensions, EXTENSION.extendedMasterSecret, () => undefined);
          if (ext.sessionTicket) extension(extensions, EXTENSION.sessionTicket, () => undefined);
          if (ext.renegotiationInfo !== undefined) extension(extensions, EXTENSION.renegotiationInfo, (e) => e.vector(1, (info) => info.hex(ext.renegotiationInfo!)));
        });
      });
    }
    case 'legacy_certificate': {
      const certificate = message as LegacyCertificate;
      return handshake(HANDSHAKE_TYPE.certificate, (body) => body.vector(3, (list) => {
        for (const cert of certificate.certificateList) list.vector(3, (data) => data.bytes(encodeCertificate(cert)));
      }));
    }
    case 'legacy_certificate_status': {
      const status = message as LegacyCertificateStatus;
      return handshake(HANDSHAKE_TYPE.certificateStatus, (body) => body.u8(OCSP_STATUS_TYPE).vector(3, (response) => response.bytes(utf8ToBytes(JSON.stringify(status.response)))));
    }
    case 'server_key_exchange': {
      const exchange = message as ServerKeyExchange;
      return handshake(HANDSHAKE_TYPE.serverKeyExchange, (body) => {
        body.bytes(serverKeyExchangeParametersBytes(exchange.params));
        if (context.version === '1.2') body.u16(signatureSchemeCode(exchange.signatureAlgorithm));
        body.vector(2, (signature) => signature.bytes(signatureBytes(exchange.signature)));
      });
    }
    case 'legacy_certificate_request': {
      const request = message as LegacyCertificateRequest;
      return handshake(HANDSHAKE_TYPE.certificateRequest, (body) => {
        body.vector(1, (types) => { for (const name of request.certificateTypes) types.u8(CERTIFICATE_TYPES[name] ?? 0); });
        if (context.version === '1.2') body.vector(2, (list) => { for (const name of request.signatureAlgorithms) list.u16(signatureSchemeCode(name)); });
        body.vector(2, () => undefined);
      });
    }
    case 'server_hello_done': return handshake(HANDSHAKE_TYPE.serverHelloDone, () => undefined);
    case 'client_key_exchange': {
      const key = (message as ClientKeyExchange).exchange;
      return handshake(HANDSHAKE_TYPE.clientKeyExchange, (body) => {
        if (key.type === 'ecdh') body.vector(1, (point) => point.hex(shareBody(key.publicKey)));
        else if (key.type === 'dh') body.vector(2, (yc) => yc.hex(evenHex(key.yc)));
        else body.vector(2, (secret) => secret.hex(key.encryptedPreMasterSecret));
      });
    }
    case 'legacy_certificate_verify': {
      const verify = message as LegacyCertificateVerify;
      return handshake(HANDSHAKE_TYPE.certificateVerify, (body) => {
        if (context.version === '1.2') body.u16(signatureSchemeCode(verify.signature.startsWith('ecdsa:') ? 'ecdsa_secp256r1_sha256' : 'rsa_pkcs1_sha256'));
        body.vector(2, (signature) => signature.bytes(signatureBytes(verify.signature)));
      });
    }
    case 'legacy_finished': return handshake(HANDSHAKE_TYPE.finished, (body) => body.hex((message as LegacyFinished).verifyData));
    case 'legacy_new_session_ticket': {
      const ticket = message as LegacyNewSessionTicket;
      return handshake(HANDSHAKE_TYPE.newSessionTicket, (body) => body.u32(ticket.lifetimeHint).vector(2, (data) => data.hex(ticket.ticket)));
    }
    default: throw new TlsDecodeError(`unsupported legacy message ${kind}`);
  }
}

export function encodeLegacyBundle(messages: readonly Message[], context: LegacyWireContext = {}): Uint8Array {
  return concatBytes(messages.map((message) => encodeLegacyMessage(message, context)));
}

function decodeServerHello(body: TlsReader): LegacyServerHello {
  const version = versionName(body.u16()) as LegacyVersion;
  const random = body.hex(32);
  const sessionId = bytesToHex(body.vector(1).rest());
  const definition = legacySuiteByCode(body.u16());
  body.u8();
  const extensions: { -readonly [K in keyof LegacyServerHello['extensions']]: LegacyServerHello['extensions'][K] } = {};
  if (!body.done) {
    const list = body.vector(2);
    while (!list.done) {
      const type = list.u16();
      const data = list.vector(2);
      if (type === EXTENSION.maxFragmentLength) extensions.maxFragmentLength = [512, 1024, 2048, 4096][data.u8() - 1];
      else if (type === EXTENSION.statusRequest) extensions.statusRequest = true;
      else if (type === EXTENSION.ecPointFormats) {
        const formats = data.vector(1);
        const names: string[] = [];
        while (!formats.done) names.push(nameForCode(EC_POINT_FORMATS, formats.u8()));
        extensions.ecPointFormats = names;
      } else if (type === EXTENSION.alpn) extensions.alpn = bytesToUtf8(data.vector(2).vector(1).rest());
      else if (type === EXTENSION.extendedMasterSecret) extensions.extendedMasterSecret = true;
      else if (type === EXTENSION.sessionTicket) extensions.sessionTicket = true;
      else if (type === EXTENSION.renegotiationInfo) extensions.renegotiationInfo = bytesToHex(data.vector(1).rest());
    }
  }
  return {
    kind: 'legacy_server_hello', version, random, sessionId, cipherSuite: definition?.name ?? 'unknown', compressionMethod: 'null',
    extensions,
  };
}

function decodeKeyExchangeParams(body: TlsReader, keyExchange: KeyExchangeKind | undefined): KeyExchangeParams {
  if (keyExchange === 'DHE_RSA') {
    const p = bytesToHex(body.vector(2).rest());
    const g = bytesToHex(body.vector(2).rest());
    const ys = bytesToHex(body.vector(2).rest());
    return { type: 'dh', p, g, ys };
  }
  if (body.u8() !== CURVE_TYPE_NAMED) throw new TlsDecodeError('unsupported curve type');
  const group = groupName(body.u16());
  return { type: 'ecdh', group, publicKey: `${group}:${bytesToHex(body.vector(1).rest())}` };
}

export function decodeLegacyMessages(bytes: Uint8Array, initial: LegacyWireContext = {}): { kind: string }[] {
  let context: LegacyWireContext = initial;
  const out: { kind: string }[] = [];
  for (const { type, body } of splitHandshakeMessages(bytes)) {
    switch (type) {
      case HANDSHAKE_TYPE.serverHello: {
        const hello = decodeServerHello(body);
        context = { version: hello.version, keyExchange: legacySuiteByName(hello.cipherSuite)?.keyExchange };
        out.push(hello);
        break;
      }
      case HANDSHAKE_TYPE.certificate: {
        const list = body.vector(3);
        const certificateList: X509Certificate[] = [];
        while (!list.done) certificateList.push(decodeCertificate(list.vector(3).rest()));
        out.push({ kind: 'legacy_certificate', certificateList } as LegacyCertificate);
        break;
      }
      case HANDSHAKE_TYPE.certificateStatus: {
        body.u8();
        out.push({ kind: 'legacy_certificate_status', response: JSON.parse(bytesToUtf8(body.vector(3).rest())) as SignedOcspResponse } as LegacyCertificateStatus);
        break;
      }
      case HANDSHAKE_TYPE.serverKeyExchange: {
        const params = decodeKeyExchangeParams(body, context.keyExchange);
        const algorithm = context.version === '1.2'
          ? signatureSchemeName(body.u16())
          : isEcdsaKeyExchange(context.keyExchange) ? 'ecdsa_sha1' : 'rsa_md5_sha1';
        const signature = signatureText(body.vector(2).rest(), algorithm.startsWith('ecdsa'));
        out.push({ kind: 'server_key_exchange', params, signatureAlgorithm: algorithm, signature } as ServerKeyExchange);
        break;
      }
      case HANDSHAKE_TYPE.certificateRequest: {
        const types = body.vector(1);
        const certificateTypes: string[] = [];
        while (!types.done) certificateTypes.push(nameForCode(CERTIFICATE_TYPES, types.u8()));
        const signatureAlgorithms: string[] = [];
        if (context.version === '1.2') {
          const list = body.vector(2);
          while (!list.done) signatureAlgorithms.push(signatureSchemeName(list.u16()));
        }
        out.push({ kind: 'legacy_certificate_request', certificateTypes, signatureAlgorithms } as LegacyCertificateRequest);
        break;
      }
      case HANDSHAKE_TYPE.serverHelloDone: out.push({ kind: 'server_hello_done' } as ServerHelloDone); break;
      case HANDSHAKE_TYPE.clientKeyExchange: {
        const exchange: ClientKeyExchange['exchange'] = context.keyExchange === 'RSA'
          ? { type: 'rsa', encryptedPreMasterSecret: bytesToHex(body.vector(2).rest()) }
          : context.keyExchange === 'DHE_RSA'
            ? { type: 'dh', yc: bytesToHex(body.vector(2).rest()) }
            : { type: 'ecdh', publicKey: `${context.group ?? ''}:${bytesToHex(body.vector(1).rest())}` };
        out.push({ kind: 'client_key_exchange', exchange } as ClientKeyExchange);
        break;
      }
      case HANDSHAKE_TYPE.certificateVerify: {
        const algorithm = context.version === '1.2' ? signatureSchemeName(body.u16()) : null;
        const ecdsa = algorithm !== null ? algorithm.startsWith('ecdsa') : isEcdsaKeyExchange(context.keyExchange);
        out.push({ kind: 'legacy_certificate_verify', signature: signatureText(body.vector(2).rest(), ecdsa) } as LegacyCertificateVerify);
        break;
      }
      case HANDSHAKE_TYPE.finished: out.push({ kind: 'legacy_finished', verifyData: bytesToHex(body.rest()) } as LegacyFinished); break;
      case HANDSHAKE_TYPE.newSessionTicket: {
        const lifetimeHint = body.u32();
        out.push({ kind: 'legacy_new_session_ticket', lifetimeHint, ticket: bytesToHex(body.vector(2).rest()) } as LegacyNewSessionTicket);
        break;
      }
      default: throw new TlsDecodeError(`unsupported handshake type ${type}`);
    }
  }
  return out;
}

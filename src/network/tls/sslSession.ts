import { base64ToBytes, bytesToBase64 } from '@/crypto/encoding';
import {
  der, children, parseDer, integerValue, contextTag, TAG, DerError, type DerNode,
} from '@/network/pki/der/Asn1';

export const SSL_SESSION_LABEL = 'SSL SESSION PARAMETERS';

const SSL_SESSION_ASN1_VERSION = 1n;

export interface SslSessionFields {
  readonly protocolVersion: number;
  readonly cipherId: number;
  readonly sessionId: Uint8Array;
  readonly masterKey: Uint8Array;
  readonly time: number;
  readonly timeout: number;
  readonly peerDer?: Uint8Array;
  readonly sessionIdContext?: Uint8Array;
  readonly verifyResult: number;
  readonly hostname?: string;
  readonly ticketLifetimeHint: number;
  readonly ticket?: Uint8Array;
  readonly flags?: number;
  readonly ticketAgeAdd: number;
  readonly maxEarlyData: number;
  readonly alpn?: string;
  readonly kexGroup?: number;
}

const integer = (value: number | bigint): Uint8Array => der.integer(BigInt(value));
const optionalInteger = (tag: number, value: number): Uint8Array[] => (value === 0 ? [] : [der.explicit(tag, integer(value))]);
const optionalOctets = (tag: number, bytes: Uint8Array | undefined): Uint8Array[] => (bytes === undefined ? [] : [der.explicit(tag, der.octetString(bytes))]);

export function encodeSslSession(fields: SslSessionFields): Uint8Array {
  const text = new TextEncoder();
  return der.sequence(
    integer(SSL_SESSION_ASN1_VERSION),
    integer(fields.protocolVersion),
    der.octetString(Uint8Array.of(fields.cipherId >> 8 & 0xff, fields.cipherId & 0xff)),
    der.octetString(fields.sessionId),
    der.octetString(fields.masterKey),
    ...optionalInteger(1, fields.time),
    ...optionalInteger(2, fields.timeout),
    ...(fields.peerDer === undefined ? [] : [der.explicit(3, fields.peerDer)]),
    der.explicit(4, der.octetString(fields.sessionIdContext ?? new Uint8Array(0))),
    ...optionalInteger(5, fields.verifyResult),
    ...optionalOctets(6, fields.hostname === undefined ? undefined : text.encode(fields.hostname)),
    ...optionalInteger(9, fields.ticketLifetimeHint),
    ...optionalOctets(10, fields.ticket),
    ...optionalInteger(13, fields.flags ?? 0),
    ...optionalInteger(14, fields.ticketAgeAdd),
    ...optionalInteger(15, fields.maxEarlyData),
    ...optionalOctets(16, fields.alpn === undefined ? undefined : text.encode(fields.alpn)),
    ...(fields.kexGroup === undefined ? [] : [der.explicit(19, integer(fields.kexGroup))]),
  );
}

function wrapped(node: DerNode, tag: number): DerNode | null {
  return node.tag === contextTag(tag, true) ? children(node)[0] ?? null : null;
}

export function decodeSslSession(bytes: Uint8Array): SslSessionFields {
  const root = parseDer(bytes);
  if (root.tag !== TAG.SEQUENCE) throw new DerError('SSL_SESSION is not a SEQUENCE');
  const items = children(root);
  if (items.length < 5 || integerValue(items[0]) !== SSL_SESSION_ASN1_VERSION) throw new DerError('unsupported SSL_SESSION version');
  const cipher = items[2].content;
  const optional = new Map<number, DerNode>();
  for (const item of items.slice(5)) {
    const inner = item.tag & 0x1f;
    const content = wrapped(item, inner);
    if (content !== null) optional.set(inner, content);
  }
  const number = (tag: number): number => {
    const node = optional.get(tag);
    return node === undefined ? 0 : Number(integerValue(node));
  };
  const octets = (tag: number): Uint8Array | undefined => optional.get(tag)?.content;
  const peer = optional.get(3);
  const hostname = octets(6);
  const alpn = octets(16);
  const decoder = new TextDecoder();
  return {
    protocolVersion: Number(integerValue(items[1])),
    cipherId: (cipher[0] << 8) | cipher[1],
    sessionId: items[3].content,
    masterKey: items[4].content,
    time: number(1),
    timeout: number(2),
    ...(peer === undefined ? {} : { peerDer: peer.raw }),
    ...(octets(4) === undefined ? {} : { sessionIdContext: octets(4) }),
    verifyResult: number(5),
    ...(hostname === undefined ? {} : { hostname: decoder.decode(hostname) }),
    ticketLifetimeHint: number(9),
    ...(octets(10) === undefined ? {} : { ticket: octets(10) }),
    ...(number(13) !== 0 ? { flags: number(13) } : {}),
    ticketAgeAdd: number(14),
    maxEarlyData: number(15),
    ...(alpn === undefined ? {} : { alpn: decoder.decode(alpn) }),
    ...(optional.has(19) ? { kexGroup: number(19) } : {}),
  };
}

export function sslSessionToPem(fields: SslSessionFields): string {
  const body = bytesToBase64(encodeSslSession(fields));
  const lines: string[] = [];
  for (let index = 0; index < body.length; index += 64) lines.push(body.slice(index, index + 64));
  return `-----BEGIN ${SSL_SESSION_LABEL}-----\n${lines.join('\n')}\n-----END ${SSL_SESSION_LABEL}-----\n`;
}

export function sslSessionFromPem(pem: string): SslSessionFields | null {
  const begin = `-----BEGIN ${SSL_SESSION_LABEL}-----`;
  const end = `-----END ${SSL_SESSION_LABEL}-----`;
  const from = pem.indexOf(begin);
  const to = pem.indexOf(end);
  if (from === -1 || to === -1) return null;
  try {
    return decodeSslSession(base64ToBytes(pem.slice(from + begin.length, to).replace(/\s+/g, '')));
  } catch {
    return null;
  }
}


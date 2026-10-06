import { bytesToHex, hexToBytes } from '@/crypto/encoding';
import type {
  OcspCertId, OcspRequestMessage, OcspResponderId, OcspResponseMessage, OcspSingle, OcspStatus,
} from '../OcspWire';
import { OCSP_RESPONSE_STATUS_CODE } from '../OcspWire';
import { decodeCertificate, encodeCertificate } from './X509Der';
import {
  der, children, concatBytes, contextTag, expectTag, integerMagnitude, oidValue, parseDer, timeValue,
  bitStringBytes, tlv, unsignedIntegerBytes, TAG, type DerNode,
} from './Asn1';
import { encodeName, decodeName } from './DistinguishedName';
import {
  OID, canonicalSerial, extension, algorithmIdentifier, algorithmFrom, signatureToDer, signatureFromDer,
} from './X509Der';

const HASH_OIDS = { sha1: OID.sha1, sha256: OID.sha256 } as const;

function encodeCertId(id: OcspCertId): Uint8Array {
  return der.sequence(
    der.sequence(der.oid(HASH_OIDS[id.hashAlgorithm]), der.null()),
    der.octetString(hexToBytes(id.issuerNameHash)),
    der.octetString(hexToBytes(id.issuerKeyHash)),
    unsignedIntegerBytes(hexToBytes(canonicalSerial(id.serialNumber))),
  );
}

function decodeCertId(node: DerNode): OcspCertId {
  const [algorithm, nameHash, keyHash, serial] = children(expectTag(node, TAG.SEQUENCE, 'CertID'));
  const oid = oidValue(children(algorithm)[0]);
  const hashAlgorithm = Object.entries(HASH_OIDS).find(([, value]) => value === oid)?.[0] as OcspCertId['hashAlgorithm'] | undefined;
  if (!hashAlgorithm) throw new Error(`unsupported CertID hash ${oid}`);
  return {
    hashAlgorithm,
    issuerNameHash: bytesToHex(nameHash.content),
    issuerKeyHash: bytesToHex(keyHash.content),
    serialNumber: canonicalSerial(bytesToHex(integerMagnitude(serial))),
  };
}

function nonceExtension(nonce: string): Uint8Array {
  return extension(OID.ocspNonce, false, der.octetString(hexToBytes(nonce)));
}

function nonceFrom(wrapper: DerNode | undefined): string | undefined {
  if (!wrapper) return undefined;
  for (const ext of children(children(wrapper)[0])) {
    const parts = children(ext);
    if (oidValue(parts[0]) === OID.ocspNonce) return bytesToHex(parseDer(parts[parts.length - 1].content).content);
  }
  return undefined;
}

export function encodeOcspRequest(request: OcspRequestMessage): Uint8Array {
  const list = der.sequence(...request.ids.map((id) => der.sequence(encodeCertId(id))));
  const extensions = request.nonce === undefined ? [] : [der.explicit(2, der.sequence(nonceExtension(request.nonce)))];
  return der.sequence(der.sequence(list, ...extensions));
}

export function decodeOcspRequest(bytes: Uint8Array): OcspRequestMessage {
  const tbs = children(expectTag(parseDer(bytes), TAG.SEQUENCE, 'OCSPRequest'))[0];
  const fields = children(tbs);
  const list = fields.find((field) => field.tag === TAG.SEQUENCE);
  if (!list) throw new Error('OCSPRequest without request list');
  const ids = children(list).map((request) => decodeCertId(children(request)[0]));
  const nonce = nonceFrom(fields.find((field) => field.tag === contextTag(2, true)));
  return { ids, ...(nonce !== undefined ? { nonce } : {}) };
}

function encodeSingle(single: OcspSingle): Uint8Array {
  let status: Uint8Array;
  if (single.status === 'good') status = tlv(contextTag(0, false), new Uint8Array(0));
  else if (single.status === 'unknown') status = tlv(contextTag(2, false), new Uint8Array(0));
  else {
    status = tlv(contextTag(1, true), concatBytes([
      der.generalizedTime(single.revokedAt ?? 0),
      ...(single.revocationReason !== undefined ? [der.explicit(0, der.enumerated(single.revocationReason))] : []),
    ]));
  }
  return der.sequence(
    encodeCertId(single.certId),
    status,
    der.generalizedTime(single.thisUpdate),
    ...(single.nextUpdate !== undefined ? [der.explicit(0, der.generalizedTime(single.nextUpdate))] : []),
  );
}

function decodeSingle(node: DerNode): OcspSingle {
  const [certId, statusNode, thisUpdate, ...rest] = children(node);
  const number = statusNode.tag & 0x1f;
  let status: OcspStatus = 'unknown';
  let revokedAt: number | undefined;
  let revocationReason: number | undefined;
  if (number === 0) status = 'good';
  else if (number === 1) {
    status = 'revoked';
    const [time, reason] = children(statusNode);
    revokedAt = timeValue(time);
    if (reason) revocationReason = children(reason)[0].content[0];
  }
  const next = rest.find((field) => field.tag === contextTag(0, true));
  return {
    certId: decodeCertId(certId), status,
    ...(revokedAt !== undefined ? { revokedAt } : {}),
    ...(revocationReason !== undefined ? { revocationReason } : {}),
    thisUpdate: timeValue(thisUpdate),
    ...(next ? { nextUpdate: timeValue(children(next)[0]) } : {}),
  };
}

function encodeResponderId(id: OcspResponderId): Uint8Array {
  return 'name' in id
    ? der.explicit(1, encodeName(id.name))
    : der.explicit(2, der.octetString(hexToBytes(id.keyHash)));
}

function decodeResponderId(node: DerNode): OcspResponderId {
  const inner = children(node)[0];
  return (node.tag & 0x1f) === 1 ? { name: decodeName(inner) } : { keyHash: bytesToHex(inner.content) };
}

type UnsignedResponse = Omit<OcspResponseMessage, 'signature' | 'signatureAlgorithm'>;

export function encodeResponseData(response: UnsignedResponse): Uint8Array {
  if (response.responder === undefined) throw new Error('OCSP response without responder id');
  return der.sequence(
    encodeResponderId(response.responder),
    der.generalizedTime(response.producedAt ?? 0),
    der.sequence(...response.singles.map(encodeSingle)),
    ...(response.nonce !== undefined ? [der.explicit(1, der.sequence(nonceExtension(response.nonce)))] : []),
  );
}

const RECEIVED_RESPONSE_DATA = new WeakMap<object, Uint8Array>();

export function responseDataOf(response: OcspResponseMessage): Uint8Array {
  return RECEIVED_RESPONSE_DATA.get(response) ?? encodeResponseData(response);
}

export function encodeOcspResponse(response: OcspResponseMessage): Uint8Array {
  const status = der.enumerated(OCSP_RESPONSE_STATUS_CODE[response.status]);
  if (response.status !== 'successful') return der.sequence(status);
  if (response.signature === undefined || response.signatureAlgorithm === undefined) {
    throw new Error('successful OCSP response without signature');
  }
  const certificates = response.responderCertificates ?? [];
  const basic = der.sequence(
    responseDataOf(response),
    algorithmIdentifier(response.signatureAlgorithm),
    der.bitString(signatureToDer(response.signatureAlgorithm, response.signature)),
    ...(certificates.length > 0 ? [der.explicit(0, der.sequence(...certificates.map(encodeCertificate)))] : []),
  );
  return der.sequence(
    status,
    der.explicit(0, der.sequence(der.oid(OID.ocspBasic), der.octetString(basic))),
  );
}

export function decodeOcspResponse(bytes: Uint8Array): OcspResponseMessage {
  const [statusNode, wrapper] = children(expectTag(parseDer(bytes), TAG.SEQUENCE, 'OCSPResponse'));
  const code = statusNode.content[0];
  const status = (Object.entries(OCSP_RESPONSE_STATUS_CODE).find(([, value]) => value === code)?.[0]) as OcspResponseMessage['status'] | undefined;
  if (!status) throw new Error(`unknown OCSP response status ${code}`);
  if (status !== 'successful' || !wrapper) return { status, singles: [] };
  const [responseType, response] = children(children(wrapper)[0]);
  if (oidValue(responseType) !== OID.ocspBasic) throw new Error('unsupported OCSP response type');
  const basic = children(parseDer(response.content));
  const [data, algorithm, signatureNode, certificates] = basic;
  const fields = children(data);
  let index = 0;
  if (fields[index].tag === contextTag(0, true)) index++;
  const responder = decodeResponderId(fields[index++]);
  const producedAt = timeValue(fields[index++]);
  const singles = children(fields[index++]).map(decodeSingle);
  const nonce = nonceFrom(fields.slice(index).find((field) => field.tag === contextTag(1, true)));
  const signatureAlgorithm = algorithmFrom(algorithm);
  const decoded: OcspResponseMessage = {
    status, responder, producedAt, singles,
    ...(nonce !== undefined ? { nonce } : {}),
    signatureAlgorithm,
    signature: signatureFromDer(signatureAlgorithm, bitStringBytes(signatureNode).bytes),
    ...(certificates ? { responderCertificates: children(children(certificates)[0]).map((node) => decodeCertificate(node.raw)) } : {}),
  };
  RECEIVED_RESPONSE_DATA.set(decoded, data.raw);
  return decoded;
}

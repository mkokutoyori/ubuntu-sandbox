import { bytesToHex } from '@/crypto/encoding';
import type { CertificateRevocationList, CrlFields, RevokedEntry } from '../CertificateRevocationList';
import {
  der, children, contextTag, expectTag, integerMagnitude, integerValue, oidValue, parseDer,
  timeValue, bitStringBytes, TAG,
} from './Asn1';
import { encodeName, decodeName } from './DistinguishedName';
import {
  OID, canonicalSerial, extension, algorithmIdentifier, algorithmFrom, signatureToDer, signatureFromDer,
  encodeExtensionSequence, decodeExtensionSequence,
} from './X509Der';

const REASON_CODES: Readonly<Record<NonNullable<RevokedEntry['reasonCode']>, number>> = {
  unspecified: 0, keyCompromise: 1, cACompromise: 2, affiliationChanged: 3, superseded: 4,
  cessationOfOperation: 5, certificateHold: 6, removeFromCRL: 8,
};

function reasonFromCode(code: number): RevokedEntry['reasonCode'] {
  return (Object.entries(REASON_CODES).find(([, value]) => value === code)?.[0]) as RevokedEntry['reasonCode'];
}

function hasExtensions(fields: CrlFields): boolean {
  return fields.crlNumber !== undefined
    || fields.authorityKeyIdentifier !== undefined
    || fields.revoked.some((entry) => entry.reasonCode !== undefined);
}

export function crlVersionOf(fields: CrlFields): 1 | 2 {
  return hasExtensions(fields) ? 2 : 1;
}

function encodeEntry(entry: RevokedEntry): Uint8Array {
  const reason = entry.reasonCode === undefined ? [] : [der.sequence(
    extension(OID.reasonCode, false, der.enumerated(REASON_CODES[entry.reasonCode])),
  )];
  return der.sequence(
    der.integer(BigInt(`0x${canonicalSerial(entry.serialNumber)}`)),
    der.time(entry.revocationDate),
    ...reason,
  );
}

export function encodeTbsCrl(fields: CrlFields): Uint8Array {
  const extensions: Uint8Array[] = [];
  if (fields.authorityKeyIdentifier !== undefined) {
    const sequence = encodeExtensionSequence({ authorityKeyIdentifier: { keyid: fields.authorityKeyIdentifier } });
    if (sequence) extensions.push(...children(parseDer(sequence)).map((node) => node.raw));
  }
  if (fields.crlNumber !== undefined) {
    extensions.push(extension(OID.crlNumber, false, der.integer(BigInt(fields.crlNumber))));
  }
  return der.sequence(
    ...(crlVersionOf(fields) === 2 ? [der.integer(1n)] : []),
    algorithmIdentifier(fields.signatureAlgorithm),
    encodeName(fields.issuer),
    der.time(fields.thisUpdate),
    der.time(fields.nextUpdate),
    ...(fields.revoked.length > 0 ? [der.sequence(...fields.revoked.map(encodeEntry))] : []),
    ...(extensions.length > 0 ? [der.explicit(0, der.sequence(...extensions))] : []),
  );
}

const RECEIVED_TBS = new WeakMap<object, Uint8Array>();

export function tbsBytesOfCrl(crl: CrlFields): Uint8Array {
  return RECEIVED_TBS.get(crl) ?? encodeTbsCrl(crl);
}

export function rememberReceivedTbs(crl: object, tbs: Uint8Array): void {
  RECEIVED_TBS.set(crl, tbs);
}

export function encodeCrl(crl: CertificateRevocationList): Uint8Array {
  return der.sequence(
    tbsBytesOfCrl(crl),
    algorithmIdentifier(crl.signatureAlgorithm),
    der.bitString(signatureToDer(crl.signatureAlgorithm, crl.signature)),
  );
}

function decodeEntry(node: ReturnType<typeof parseDer>): RevokedEntry {
  const [serial, date, extensions] = children(node);
  let reasonCode: RevokedEntry['reasonCode'];
  if (extensions) {
    for (const ext of children(extensions)) {
      const parts = children(ext);
      if (oidValue(parts[0]) === OID.reasonCode) {
        const code = parseDer(parts[parts.length - 1].content).content[0];
        reasonCode = reasonFromCode(code);
      }
    }
  }
  return {
    serialNumber: canonicalSerial(bytesToHex(integerMagnitude(serial))),
    revocationDate: timeValue(date),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

export interface DecodedCrl {
  readonly fields: CrlFields;
  readonly signature: string;
  readonly tbs: Uint8Array;
}

export function decodeCrl(bytes: Uint8Array): DecodedCrl {
  const outer = expectTag(parseDer(bytes), TAG.SEQUENCE, 'CertificateList');
  const [tbs, , signatureNode] = children(outer);
  const fields = children(tbs);
  let index = 0;
  if (fields[index].tag === TAG.INTEGER) index++;
  const algorithm = algorithmFrom(fields[index++]);
  const issuer = decodeName(fields[index++]);
  const thisUpdate = timeValue(fields[index++]);
  const nextUpdate = fields[index] && (fields[index].tag === TAG.UTC_TIME || fields[index].tag === TAG.GENERALIZED_TIME)
    ? timeValue(fields[index++]) : Number.MAX_SAFE_INTEGER;
  const revoked = fields[index] && fields[index].tag === TAG.SEQUENCE ? children(fields[index++]).map(decodeEntry) : [];
  let crlNumber: number | undefined;
  let authorityKeyIdentifier: string | undefined;
  const wrapper = fields[index];
  if (wrapper && wrapper.tag === contextTag(0, true)) {
    const sequence = children(wrapper)[0];
    for (const ext of children(sequence)) {
      const parts = children(ext);
      if (oidValue(parts[0]) === OID.crlNumber) crlNumber = Number(integerValue(parseDer(parts[parts.length - 1].content)));
    }
    authorityKeyIdentifier = decodeExtensionSequence(sequence).authorityKeyIdentifier?.keyid;
  }
  return {
    fields: {
      version: 2,
      issuer,
      thisUpdate,
      nextUpdate,
      signatureAlgorithm: algorithm,
      revoked,
      ...(crlNumber !== undefined ? { crlNumber } : {}),
      ...(authorityKeyIdentifier !== undefined ? { authorityKeyIdentifier } : {}),
    },
    signature: signatureFromDer(algorithm, bitStringBytes(signatureNode).bytes),
    tbs: tbs.raw,
  };
}

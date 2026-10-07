import { PkiKeyPair } from '../PkiKeyPair';
import type { CertificateRequest } from '../pem';
import {
  der, children, concatBytes, contextTag, expectTag, oidValue, parseDer, bitStringBytes, integerValue, TAG,
} from './Asn1';
import { encodeName, decodeName } from './DistinguishedName';
import {
  OID, encodeSubjectPublicKeyInfo, decodeSubjectPublicKeyInfo, encodeExtensionSequence, decodeExtensionSequence,
  algorithmIdentifier, algorithmFrom, signatureToDer, signatureFromDer,
} from './X509Der';

type RequestFields = Pick<CertificateRequest, 'subject' | 'publicKey' | 'extensions'>;

const RECEIVED_INFO = new WeakMap<object, Uint8Array>();

export function encodeCertificationRequestInfo(fields: RequestFields): Uint8Array {
  const extensions = fields.extensions ? encodeExtensionSequence(fields.extensions) : null;
  const attributes = extensions ? [der.sequence(der.oid(OID.extensionRequest), der.set(extensions))] : [];
  return der.sequence(
    der.integer(0n),
    encodeName(fields.subject),
    encodeSubjectPublicKeyInfo(fields.publicKey),
    der.implicit(0, concatBytes(attributes), true),
  );
}

export function certificationRequestInfoOf(csr: RequestFields): Uint8Array {
  return RECEIVED_INFO.get(csr) ?? encodeCertificationRequestInfo(csr);
}

export function encodeCertificateRequest(csr: CertificateRequest): Uint8Array {
  return der.sequence(
    certificationRequestInfoOf(csr),
    algorithmIdentifier(csr.signatureAlgorithm),
    der.bitString(signatureToDer(csr.signatureAlgorithm, csr.signature)),
  );
}

export function decodeCertificateRequest(bytes: Uint8Array): CertificateRequest {
  const outer = expectTag(parseDer(bytes), TAG.SEQUENCE, 'CertificationRequest');
  const [info, algorithm, signatureNode] = children(outer);
  const [version, subject, spki, attributes] = children(info);
  if (integerValue(version) !== 0n) throw new Error('unsupported CertificationRequest version');
  let extensions: CertificateRequest['extensions'];
  if (attributes && attributes.tag === contextTag(0, true)) {
    for (const attribute of children(attributes)) {
      const [type, values] = children(attribute);
      if (oidValue(type) === OID.extensionRequest) {
        const decoded = decodeExtensionSequence(children(values)[0]);
        if (Object.keys(decoded).length > 0) extensions = decoded;
      }
    }
  }
  const signatureAlgorithm = algorithmFrom(algorithm);
  const decoded: CertificateRequest = {
    subject: decodeName(subject),
    publicKey: decodeSubjectPublicKeyInfo(spki),
    signatureAlgorithm,
    signature: signatureFromDer(signatureAlgorithm, bitStringBytes(signatureNode).bytes),
    ...(extensions ? { extensions } : {}),
  };
  RECEIVED_INFO.set(decoded, info.raw);
  return decoded;
}

export function verifyCertificateRequestSignature(csr: CertificateRequest): boolean {
  return PkiKeyPair.verify(csr.publicKey, certificationRequestInfoOf(csr), csr.signature);
}

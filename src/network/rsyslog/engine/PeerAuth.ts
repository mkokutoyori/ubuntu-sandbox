import { RS_RET } from './Log';
import type { RuntimeLog } from './Modules';

export type NetstreamAuthMode = 'anon' | 'x509/fingerprint' | 'x509/certvalid' | 'x509/name';
export type PermitExpiredCerts = 'off' | 'warn' | 'on';

export type ChainVerdict =
  | 'valid' | 'expired' | 'signer-not-found' | 'signer-not-ca' | 'insecure-algorithm' | 'revoked' | 'purpose-mismatch' | 'invalid';

export interface PeerCertificateView {
  readonly fingerprintSha1: string;
  readonly fingerprintSha256: string;
  readonly dnsNames: readonly string[];
  readonly ipAddresses: readonly string[];
  readonly commonName: string | null;
  readonly chain: ChainVerdict;
  readonly activationTimesMs: readonly number[];
  readonly description: string;
}

export interface PeerAuthPolicy {
  readonly authMode: NetstreamAuthMode;
  readonly permittedPeers: readonly string[];
  readonly connectHost: string | null;
  readonly permitExpiredCerts: PermitExpiredCerts;
  readonly prioritizeSan: boolean;
  readonly crlNextUpdateMs: number | null;
}

export function parseAuthMode(text: string | null): NetstreamAuthMode | null {
  if (text === null) return 'x509/name';
  const lower = text.toLowerCase();
  if (lower === 'x509/name' || lower === 'x509/fingerprint' || lower === 'x509/certvalid' || lower === 'anon') return lower;
  return null;
}

export function parsePermitExpired(text: string | null): PermitExpiredCerts | null {
  if (text === null) return 'off';
  const lower = text.toLowerCase();
  return lower === 'off' || lower === 'warn' || lower === 'on' ? lower : null;
}

type WildcardKind = 'none' | 'at-start' | 'at-end' | 'match-all' | 'empty';

interface WildcardPart {
  readonly kind: WildcardKind;
  readonly text: string;
}

function compileWildcard(id: string): WildcardPart[] | null | 'plain' {
  if (!id.includes('*')) return 'plain';
  const parts: WildcardPart[] = [];
  const components = id.split('.');
  for (let index = 0; index < components.length; index++) {
    const component = components[index];
    if (component.length === 0) {
      parts.push({ kind: 'empty', text: '' });
      continue;
    }
    let kind: WildcardKind = 'none';
    let source = component;
    if (source.startsWith('*')) {
      kind = 'at-start';
      source = source.slice(1);
    }
    const star = source.indexOf('*');
    if (star >= 0) {
      if (star + 1 === source.length && kind !== 'at-start') {
        kind = 'at-end';
        source = source.slice(0, star);
      } else {
        return null;
      }
    }
    if (component.length === 1 && kind === 'at-start') kind = 'match-all';
    parts.push({ kind, text: source });
  }
  return parts;
}

export function permittedPeerMatches(permitted: string, name: string): boolean {
  const compiled = compileWildcard(permitted);
  if (compiled === 'plain') return permitted === name;
  if (compiled === null) return false;
  let remaining = compiled;
  let cursor = 0;
  while (cursor < name.length) {
    if (remaining.length === 0) return false;
    const part = remaining[0];
    let end = name.indexOf('.', cursor);
    if (end < 0) end = name.length;
    const component = name.slice(cursor, end);
    switch (part.kind) {
      case 'none':
        if (component !== part.text) return false;
        break;
      case 'at-start':
        if (!component.endsWith(part.text)) return false;
        break;
      case 'at-end':
        if (!component.startsWith(part.text)) return false;
        break;
      case 'empty':
        if (component.length > 0) return false;
        break;
      case 'match-all':
        break;
    }
    remaining = remaining.slice(1);
    cursor = end < name.length ? end + 1 : end;
  }
  return remaining.length === 0;
}

export function validatePermittedPeers(peers: readonly string[], runtime: RuntimeLog): boolean {
  let valid = true;
  for (const peer of peers) {
    if (compileWildcard(peer) === null) {
      runtime.error(`error compiling wildcard expression '${peer}'`, RS_RET.INVALID_WILDCARD);
      valid = false;
    }
  }
  return valid;
}

export interface PeerAuthContext {
  readonly runtime: RuntimeLog;
  readonly nowMs: number;
  readonly remoteName: string;
  reportAuthError: boolean;
}

function nameMatches(policy: PeerAuthPolicy, candidate: string): boolean {
  if (policy.permittedPeers.length > 0) return policy.permittedPeers.some((peer) => permittedPeerMatches(peer, candidate));
  return policy.connectHost !== null && candidate === policy.connectHost;
}

function checkFingerprint(policy: PeerAuthPolicy, certificate: PeerCertificateView, context: PeerAuthContext): number {
  const matched = policy.permittedPeers.some((peer) => peer === certificate.fingerprintSha1 || peer === certificate.fingerprintSha256);
  if (matched) return RS_RET.NO_ERRCODE;
  if (context.reportAuthError) {
    context.runtime.error(`error: peer fingerprint '${certificate.fingerprintSha1}' unknown - we are not permitted to talk to it`, RS_RET.INVALID_FINGERPRINT);
    context.reportAuthError = false;
  }
  return RS_RET.INVALID_FINGERPRINT;
}

function checkName(policy: PeerAuthPolicy, certificate: PeerCertificateView, context: PeerAuthContext): number {
  let matched = false;
  let haveSan = false;
  const seen: string[] = [];
  for (const dns of certificate.dnsNames) {
    haveSan = true;
    if (dns.length === 0 || dns.length >= 1024 || dns.includes('\u0000')) {
      seen.push('DNSname: <invalid>; ');
      continue;
    }
    seen.push(`DNSname: ${dns}; `);
    if (!matched && nameMatches(policy, dns)) matched = true;
  }
  for (const address of certificate.ipAddresses) {
    haveSan = true;
    seen.push(`IPaddress: ${address}; `);
    if (!matched && nameMatches(policy, address)) matched = true;
  }
  if (!matched && (!policy.prioritizeSan || !haveSan) && certificate.commonName !== null) {
    seen.push(`CN: ${certificate.commonName}; `);
    if (nameMatches(policy, certificate.commonName)) matched = true;
  }
  if (matched) return RS_RET.NO_ERRCODE;
  if (context.reportAuthError) {
    context.runtime.error(`error: peer name not authorized -  not permitted to talk to it. Names: ${seen.join('')}`, RS_RET.INVALID_FINGERPRINT);
    context.reportAuthError = false;
  }
  return RS_RET.INVALID_FINGERPRINT;
}

function checkValidity(policy: PeerAuthPolicy, certificate: PeerCertificateView, context: PeerAuthContext): number {
  const { runtime } = context;
  let abort = false;
  let code: number = RS_RET.CERT_INVALID;
  let cause = '';
  switch (certificate.chain) {
    case 'valid':
      break;
    case 'expired':
      if (policy.permitExpiredCerts === 'off') {
        abort = true;
        code = RS_RET.CERT_EXPIRED;
      } else if (policy.permitExpiredCerts === 'warn') {
        runtime.log(4, RS_RET.NO_ERRCODE, 'Warning, certificate expired but expired certs are permitted');
      }
      cause = 'certificate expired';
      break;
    case 'signer-not-found':
      abort = true;
      cause = 'signer not found';
      break;
    case 'signer-not-ca':
      abort = true;
      cause = 'signer is not a CA';
      break;
    case 'insecure-algorithm':
      abort = true;
      cause = 'insecure algorithm';
      break;
    case 'revoked':
      abort = true;
      code = RS_RET.CERT_REVOKED;
      cause = 'certificate revoked';
      break;
    case 'purpose-mismatch':
      abort = true;
      cause = 'key purpose OID does not match';
      break;
    case 'invalid':
      abort = true;
      cause = 'GnuTLS returned no specific reason';
      break;
  }
  if (abort) {
    runtime.error(`not permitted to talk to peer '${context.remoteName}', certificate invalid: ${cause}`, RS_RET.NO_ERRCODE);
    runtime.error(`invalid cert info: ${certificate.description}`, RS_RET.NO_ERRCODE);
    return code;
  }
  for (let index = 0; index < certificate.activationTimesMs.length; index++) {
    if (certificate.activationTimesMs[index] > context.nowMs) {
      runtime.error(`not permitted to talk to peer '${context.remoteName}': certificate ${index} not yet active`, RS_RET.CERT_NOT_YET_ACTIVE);
      runtime.error(`invalid cert info: ${certificate.description}`, RS_RET.CERT_NOT_YET_ACTIVE);
      return RS_RET.CERT_NOT_YET_ACTIVE;
    }
  }
  return RS_RET.NO_ERRCODE;
}

export function authorizePeer(policy: PeerAuthPolicy, certificate: PeerCertificateView | null, context: PeerAuthContext): number {
  if (policy.crlNextUpdateMs !== null && policy.crlNextUpdateMs > 0 && context.nowMs > policy.crlNextUpdateMs) {
    context.runtime.error(`CRL has expired (nextUpdate passed), rejecting peer '${context.remoteName}'`, RS_RET.CRL_INVALID);
    return RS_RET.CRL_INVALID;
  }
  if (policy.authMode === 'anon') return RS_RET.NO_ERRCODE;
  if (certificate === null) {
    if (policy.authMode === 'x509/certvalid' || policy.authMode === 'x509/name') {
      context.runtime.error(`peer ${context.remoteName} did not provide a certificate, not permitted to talk to it`, RS_RET.TLS_NO_CERT);
    } else if (context.reportAuthError) {
      context.runtime.error(`error: peer ${context.remoteName} did not provide a certificate, not permitted to talk to it`, RS_RET.TLS_NO_CERT);
      context.reportAuthError = false;
    }
    return RS_RET.TLS_NO_CERT;
  }
  switch (policy.authMode) {
    case 'x509/name': {
      const validity = checkValidity(policy, certificate, context);
      return validity !== RS_RET.NO_ERRCODE ? validity : checkName(policy, certificate, context);
    }
    case 'x509/fingerprint':
      return checkFingerprint(policy, certificate, context);
    case 'x509/certvalid':
      return checkValidity(policy, certificate, context);
  }
}

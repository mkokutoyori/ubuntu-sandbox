import type { X509Certificate } from '../../../pki/X509Certificate';
import type { PkiPrivateKey, PkiPublicKey } from '../../../pki/PkiKeyPair';
import { pemToCert, pemToPrivateKey } from '../../../pki/pem';

export interface LocalCertificate {
  readonly name: string;
  readonly certificate: X509Certificate;
  readonly privateKey: PkiPrivateKey;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly comments?: string;
  readonly source?: 'factory' | 'user' | 'bundle';
}

export interface LocalCertificateRequest {
  readonly name: string;
  readonly subject: string;
  readonly keySize: number;
  readonly publicKey: PkiPublicKey;
  readonly privateKey: PkiPrivateKey;
  readonly privateKeyPem: string;
  readonly csrPem: string;
}

export interface TrustAnchor {
  readonly name: string;
  readonly certificate: X509Certificate;
  readonly certificatePem: string;
  readonly trusted: boolean;
}

type Deferred<T> = T | (() => T);

function resolved<T extends object>(entries: Map<string, Deferred<T>>, name: string): T | undefined {
  const entry = entries.get(name);
  if (typeof entry !== 'function') return entry;
  const value = entry();
  entries.set(name, value);
  return value;
}

export class CertificateStore {
  private readonly locals = new Map<string, Deferred<LocalCertificate>>();
  private readonly authorities = new Map<string, Deferred<TrustAnchor>>();
  private readonly requests = new Map<string, LocalCertificateRequest>();

  setLocal(entry: LocalCertificate): void {
    this.locals.set(entry.name, entry);
  }

  setLocalOnFirstRead(name: string, build: () => LocalCertificate): void {
    this.locals.set(name, build);
  }

  hasLocal(name: string): boolean {
    return this.locals.has(name);
  }

  removeLocal(name: string): boolean {
    return this.locals.delete(name);
  }

  local(name: string): LocalCertificate | undefined {
    return resolved(this.locals, name);
  }

  localNames(): readonly string[] {
    return Object.freeze([...this.locals.keys()]);
  }

  setRequest(entry: LocalCertificateRequest): void {
    this.requests.set(entry.name, entry);
  }

  request(name: string): LocalCertificateRequest | undefined {
    return this.requests.get(name);
  }

  requestNames(): readonly string[] {
    return Object.freeze([...this.requests.keys()]);
  }

  removeRequest(name: string): boolean {
    return this.requests.delete(name);
  }

  setAuthority(entry: TrustAnchor): void {
    this.authorities.set(entry.name, entry);
  }

  setAuthorityOnFirstRead(name: string, build: () => TrustAnchor): void {
    this.authorities.set(name, build);
  }

  removeAuthority(name: string): boolean {
    return this.authorities.delete(name);
  }

  authority(name: string): TrustAnchor | undefined {
    return resolved(this.authorities, name);
  }

  authorityNames(): readonly string[] {
    return Object.freeze([...this.authorities.keys()]);
  }

  trustAnchors(): readonly X509Certificate[] {
    return Object.freeze([...this.authorities.keys()]
      .map(name => resolved(this.authorities, name)!)
      .filter(entry => entry.trusted)
      .map(entry => entry.certificate));
  }
}

export function readCertificatePem(pem: string): X509Certificate | null {
  return pemToCert(pem);
}

export function readPrivateKeyPem(pem: string): PkiPrivateKey | null {
  return pemToPrivateKey(pem);
}

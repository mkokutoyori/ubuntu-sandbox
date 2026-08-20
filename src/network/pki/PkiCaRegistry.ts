import { CertificateAuthority } from './CertificateAuthority';

/**
 * Simulates a CA reachable over the network by its enrollment endpoint:
 * routers that configure the same `crypto pki trustpoint` enrollment
 * URL (or, absent one, the same trustpoint name) authenticate against and
 * get certificates issued by the same CertificateAuthority instance, so
 * they end up in each other's trust anchors — exactly as two real routers
 * enrolling with the same CA would. Routers pointed at different
 * URLs/names get distinct, mutually-untrusted CAs.
 */
const registry = new Map<string, CertificateAuthority>();

export function getOrCreateCA(key: string, now: number = Date.now()): CertificateAuthority {
  let ca = registry.get(key);
  if (!ca) {
    ca = CertificateAuthority.generate(`CN=${key}`, { now });
    registry.set(key, ca);
  }
  return ca;
}

export function resetPkiCaRegistry(): void {
  registry.clear();
}

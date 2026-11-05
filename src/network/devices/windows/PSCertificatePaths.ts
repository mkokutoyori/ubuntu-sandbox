import type { IPkiProvider } from '@/powershell/providers/PSProviders';

const PROVIDER_PREFIX = 'Microsoft.PowerShell.Security\\Certificate::';

export interface CertificatePath {
  readonly location: string | null;
  readonly store: string | null;
  readonly thumbprint: string | null;
}

export function isCertificatePath(path: string): boolean {
  return /^Cert:/i.test(path) || path.toLowerCase().startsWith(PROVIDER_PREFIX.toLowerCase());
}

export function parseCertificatePath(path: string): CertificatePath {
  const stripped = /^Cert:/i.test(path) ? path.slice(5) : path.slice(PROVIDER_PREFIX.length);
  const [location = null, store = null, thumbprint = null] = stripped.split(/[\\/]+/).filter((part) => part !== '');
  return { location, store, thumbprint };
}

export function certificateProviderPath(location: string, store?: string): string {
  return `${PROVIDER_PREFIX}${store === undefined ? location : `${location}\\${store}`}`;
}

export type CertificateEntry = NonNullable<ReturnType<IPkiProvider['certificatesIn']>>[number];

export type CertificateListing =
  | { readonly kind: 'locations'; readonly names: readonly string[] }
  | { readonly kind: 'stores'; readonly location: string; readonly names: readonly string[] }
  | { readonly kind: 'certificates'; readonly location: string; readonly store: string; readonly entries: readonly CertificateEntry[] };

const LOCATIONS = ['CurrentUser', 'LocalMachine'] as const;

export function listCertificatePath(pki: IPkiProvider, path: string): CertificateListing | null {
  const { location, store, thumbprint } = parseCertificatePath(path);
  if (location === null) return { kind: 'locations', names: LOCATIONS };
  const knownLocation = LOCATIONS.find((name) => name.toLowerCase() === location.toLowerCase());
  const stores = knownLocation === undefined ? null : pki.certificateStores(knownLocation);
  if (knownLocation === undefined || stores === null) return null;
  if (store === null) return { kind: 'stores', location: knownLocation, names: stores };
  const knownStore = stores.find((name) => name.toLowerCase() === store.toLowerCase());
  const entries = knownStore === undefined ? null : pki.certificatesIn(knownLocation, knownStore);
  if (knownStore === undefined || entries === null) return null;
  const wanted = thumbprint?.toUpperCase();
  const kept = wanted === undefined ? entries : entries.filter((entry) => entry.thumbprint === wanted);
  if (wanted !== undefined && kept.length === 0) return null;
  return { kind: 'certificates', location: knownLocation, store: knownStore, entries: kept };
}

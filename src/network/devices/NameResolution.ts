import { IPAddress } from '../core/types';

export interface HostnameResolver {
  resolveHostname(name: string): Promise<IPAddress | null>;
}

export function hostnameResolverOf(device: unknown): HostnameResolver | null {
  const candidate = device as { resolveHostname?: unknown } | null;
  return typeof candidate?.resolveHostname === 'function' ? (candidate as HostnameResolver) : null;
}

export async function resolveHostnameFor(device: unknown, name: string): Promise<string | null> {
  const literal = IPAddress.tryParse(name);
  if (literal !== null) return literal.toString();
  const resolver = hostnameResolverOf(device);
  if (resolver === null) return null;
  const address = await resolver.resolveHostname(name);
  return address === null ? null : address.toString();
}

interface SyncNss {
  lookup<T>(database: string, query: (source: { gethostbyname?: (name: string, family: number) => T }) => T | undefined): { status: string; entry?: T };
}

export function nssAddress(nss: unknown, name: string): string | null {
  const found = (nss as SyncNss).lookup<Array<{ addressFamily: number; address: string }>>('hosts', (source) => source.gethostbyname?.(name, 2));
  if (found.status !== 'SUCCESS' || !found.entry) return null;
  const entry = found.entry.find((host) => host.addressFamily === 2);
  return entry === undefined ? null : entry.address;
}

export async function preResolved(
  ctx: { readonly net: { resolveHostname(name: string): Promise<IPAddress | null> } },
  names: Iterable<string>,
): Promise<ReadonlyMap<string, string>> {
  const resolved = new Map<string, string>();
  for (const name of names) {
    if (name === '' || IPAddress.tryParse(name) !== null || resolved.has(name)) continue;
    const address = await ctx.net.resolveHostname(name);
    if (address !== null) resolved.set(name, address.toString());
  }
  return resolved;
}

const DOTTED_NAME = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function hostnamesIn(words: Iterable<string>): string[] {
  return [...words].filter((word) => DOTTED_NAME.test(word) && IPAddress.tryParse(word) === null);
}

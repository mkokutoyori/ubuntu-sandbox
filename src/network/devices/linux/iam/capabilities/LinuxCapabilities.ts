export type LinuxCapability = 'CAP_NET_RAW';

export interface CapabilityHolder {
  readonly uid: number;
}

const ROOT_EFFECTIVE_SET: ReadonlySet<LinuxCapability> = new Set<LinuxCapability>(['CAP_NET_RAW']);

export function holdsCapability(holder: CapabilityHolder, capability: LinuxCapability): boolean {
  return holder.uid === 0 && ROOT_EFFECTIVE_SET.has(capability);
}

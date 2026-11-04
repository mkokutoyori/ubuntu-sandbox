import { findPackage } from '../../packages/PackageDatabase';

const DISTRIBUTION_SUFFIX = 'Ubuntu';

export function bindVersion(): string {
  return `${findPackage('dnsutils')?.version ?? ''}-${DISTRIBUTION_SUFFIX}`;
}

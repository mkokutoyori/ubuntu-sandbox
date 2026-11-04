import { findPackage } from '../packages/PackageDatabase';

export function bindPackageVersion(): string {
  return `${findPackage('bind9')!.version}-Ubuntu`;
}

export function bindStatusVersion(): string {
  return `BIND ${bindPackageVersion()} (Extended Support Version) <id:>`;
}

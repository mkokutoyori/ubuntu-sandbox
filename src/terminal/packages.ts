/**
 * STUB FILE - will be rebuilt with TDD
 * Package manager for terminal
 */

import { DeviceType } from '@/domain/devices';

export class PackageManager {
  private installedPackages: Set<string> = new Set();

  install(packageName: string): string {
    this.installedPackages.add(packageName);
    return `STUB: Package ${packageName} installed`;
  }

  uninstall(packageName: string): string {
    this.installedPackages.delete(packageName);
    return `STUB: Package ${packageName} uninstalled`;
  }

  isInstalled(packageName: string): boolean {
    return this.installedPackages.has(packageName);
  }

  list(): string[] {
    return Array.from(this.installedPackages);
  }
}

export const packageManager = new PackageManager();

export function preInstallForDevice(deviceType: DeviceType): void {
  // Stub implementation for pre-installing packages
  console.log(`STUB: Pre-installing packages for ${deviceType}`);
}

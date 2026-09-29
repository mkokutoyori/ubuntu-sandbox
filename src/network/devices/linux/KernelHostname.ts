export const KERNEL_HOSTNAME_PATH = '/proc/sys/kernel/hostname';
export const STATIC_HOSTNAME_PATH = '/etc/hostname';

export interface HostnameFiles {
  readFile(path: string): string | null;
}

export function staticHostname(files: HostnameFiles): string {
  return (files.readFile(STATIC_HOSTNAME_PATH) ?? 'localhost').trim();
}

export function kernelHostname(files: HostnameFiles): string {
  return (files.readFile(KERNEL_HOSTNAME_PATH) ?? files.readFile(STATIC_HOSTNAME_PATH) ?? 'localhost').trim();
}

export type HostnameSource = string | (() => string);

export function hostnameOf(source: HostnameSource): string {
  return typeof source === 'function' ? source() : source;
}

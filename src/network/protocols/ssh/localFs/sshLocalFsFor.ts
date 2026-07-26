/**
 * sshLocalFsFor — where a given device keeps the files its SSH *client*
 * needs (known_hosts, identity files).
 *
 * The client itself is one implementation for every vendor; the only
 * thing that genuinely differs is which store it writes into. That
 * difference is answered here, once, so adding a vendor is a case in
 * this function rather than a second SSH client.
 *
 * Resolution order:
 *   1. A Linux VFS, when the device has one — used as-is.
 *   2. A Windows disk — wrapped so POSIX paths land on `C:\`.
 *   3. Anything else (routers, switches) — a per-device memory store,
 *      standing in for the NVRAM a real router keeps host keys in.
 */

import type { Equipment } from '@/network/equipment/Equipment';
import type { ISshLocalFs } from '../ISshLocalFs';
import { WindowsSshLocalFs } from './WindowsSshLocalFs';
import { MemorySshLocalFs } from './MemorySshLocalFs';

const fallbackStores = new WeakMap<object, ISshLocalFs>();

export function sshLocalFsFor(device: Equipment): ISshLocalFs {
  const dev = device as unknown as {
    executor?: { vfs?: ISshLocalFs };
    getFileSystem?: () => ConstructorParameters<typeof WindowsSshLocalFs>[0];
  };

  const linuxVfs = dev.executor?.vfs;
  if (linuxVfs) return linuxVfs;

  const windowsFs = dev.getFileSystem?.();
  if (windowsFs) {
    const cached = fallbackStores.get(device as unknown as object);
    if (cached) return cached;
    const adapter = new WindowsSshLocalFs(windowsFs);
    fallbackStores.set(device as unknown as object, adapter);
    return adapter;
  }

  const cached = fallbackStores.get(device as unknown as object);
  if (cached) return cached;
  const store = new MemorySshLocalFs();
  fallbackStores.set(device as unknown as object, store);
  return store;
}

/**
 * Where this device's SSH client keeps `known_hosts` for `user`. Linux
 * and the memory store use a POSIX home; Windows resolves onto
 * `C:\Users\<user>\.ssh\` through {@link WindowsSshLocalFs}.
 */
export function knownHostsPathFor(device: Equipment, user: string): string {
  const dev = device as unknown as { getFileSystem?: () => unknown; executor?: { vfs?: unknown } };
  if (!dev.executor?.vfs && dev.getFileSystem) return `/Users/${user}/.ssh/known_hosts`;
  return user === 'root' ? '/root/.ssh/known_hosts' : `/home/${user}/.ssh/known_hosts`;
}

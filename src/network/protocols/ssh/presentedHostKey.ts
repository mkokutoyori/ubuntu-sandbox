/**
 * presentedHostKey — the host key a target really offers during the
 * handshake, as a client must record it in `known_hosts`.
 *
 * Devices also expose a `getSshHostKey()` descriptor, but that one is
 * synthesised from the device id and is not what crosses the wire. A
 * client that stored it produced an entry the next connection could
 * only read as a host-key mismatch. The authority is the key file the
 * server presents from, so that is what this reads.
 */

import type { Equipment } from '@/network/equipment/Equipment';

export interface PresentedHostKey {
  readonly keyType: string;
  readonly publicKey: string;
}

const HOST_KEY_PATH = '/etc/ssh/ssh_host_ed25519_key.pub';

/**
 * Null when the target keeps no key file — a bare router or a test
 * double. Callers record nothing rather than invent an entry.
 */
export function presentedHostKey(target: Equipment): PresentedHostKey | null {
  const vfs = (target as unknown as {
    executor?: { vfs?: { readFile: (p: string) => string | null } };
  }).executor?.vfs;
  const raw = vfs?.readFile(HOST_KEY_PATH) ?? '';
  const [keyType, publicKey] = raw.trim().split(/\s+/);
  if (!keyType || !publicKey) return null;
  return { keyType, publicKey };
}

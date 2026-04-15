/**
 * Internal helper: read the configured DNS resolver IP from
 * `/etc/resolv.conf` in the machine's virtual filesystem.
 *
 * Shared by `dig`, `nslookup`, and `host`. Returns '' when no
 * resolver is configured (callers will then surface the usual
 * "no servers could be reached" diagnostic).
 */

import type { LinuxCommandExecutor } from '../../LinuxCommandExecutor';

export function readResolverIP(executor: LinuxCommandExecutor): string {
  const content = executor.readFile('/etc/resolv.conf');
  if (!content) return '';
  const match = content.match(/nameserver\s+(\S+)/);
  return match ? match[1] : '';
}

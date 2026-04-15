/**
 * DHCP lease-file pseudo-files under `/var/lib/dhcp/`.
 *
 * `cat /var/lib/dhcp/dhclient.<iface>.leases` is intercepted before it
 * reaches the regular VFS so it can render the live lease state of the
 * DHCP client. This is not a stand-alone command but a *hook* invoked
 * from `LinuxMachine`'s cat dispatch (see `linux_gap.md` §8.6).
 *
 * Returns:
 *   - the formatted lease text for a matching interface
 *   - the concatenation of every interface's lease for the umbrella
 *     `/var/lib/dhcp/dhclient.leases`
 *   - `null` if the path is not a DHCP lease file (caller should fall
 *     through to the regular `cat` handler).
 */

import type { LinuxNetKernel } from '../../LinuxNetKernel';

export function readDhcpLeaseFile(net: LinuxNetKernel, path: string): string | null {
  const dhcp = net.getDhcpClient();

  // /var/lib/dhcp/dhclient.<iface>.leases
  const leaseMatch = path.match(/\/var\/lib\/dhcp\/dhclient\.(\w+)\.leases/);
  if (leaseMatch) {
    return dhcp.formatLeaseFile(leaseMatch[1]);
  }

  // /var/lib/dhcp/dhclient.leases — concatenate every interface
  if (path === '/var/lib/dhcp/dhclient.leases') {
    const outputs: string[] = [];
    for (const [name] of net.getPorts()) {
      const lease = dhcp.formatLeaseFile(name);
      if (lease) outputs.push(lease);
    }
    return outputs.join('\n\n');
  }

  return null;
}

/** True if `path` points at a `/var/lib/dhcp/dhclient*` file. */
export function isDhcpLeasePath(path: string): boolean {
  return path.startsWith('/var/lib/dhcp/dhclient');
}

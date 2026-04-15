/**
 * `ps` augmentation: render running `dhclient` processes.
 *
 * The real `ps` output is produced by `LinuxCommandExecutor`, but it
 * has no awareness of the DHCP client of the underlying `EndHost`.
 * `LinuxMachine` calls this helper to inject a per-interface
 * `dhclient <iface>` line for every interface where the DHCP client
 * still has a process running.
 *
 * Stable PIDs would be nicer for tests, but the legacy LinuxPC
 * implementation already used a random PID range (1000–9999), so the
 * behaviour is preserved verbatim. See `linux_gap.md` §4 / §8.6.
 */

import type { LinuxNetKernel } from '../../LinuxNetKernel';

export function dhclientPsLines(net: LinuxNetKernel): string[] {
  const dhcp = net.getDhcpClient();
  const lines: string[] = [];
  for (const [name] of net.getPorts()) {
    if (dhcp.isProcessRunning(name)) {
      const pid = 1000 + Math.floor(Math.random() * 9000);
      lines.push(`root     ${pid}  0.0  0.1  5432  2100 ?  Ss  00:00  0:00 dhclient ${name}`);
    }
  }
  return lines;
}

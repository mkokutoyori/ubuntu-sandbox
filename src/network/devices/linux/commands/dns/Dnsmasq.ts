/**
 * `dnsmasq` — start the local DNS daemon by parsing a config file.
 *
 * Reads `/etc/dnsmasq.conf` (or `-C <file>`) from the virtual
 * filesystem, optionally pulls additional records from an
 * `addn-hosts=` directive, then hands the resulting config to the
 * machine's `DnsService` and starts it.
 *
 * Extracted from `LinuxPC.cmdDnsmasq`. Now usable from any
 * `LinuxMachine`, so a `LinuxServer` can finally be a DNS server —
 * which is the whole point. See `linux_gap.md` §4 and §8.4 (PR 8).
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const dnsmasqCommand: LinuxCommand = {
  name: 'dnsmasq',
  needsNetworkContext: true,

  run(ctx: LinuxCommandContext, args: string[]): string {
    let configFile = '/etc/dnsmasq.conf';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-C' && args[i + 1]) {
        configFile = args[i + 1];
        i++;
      }
    }

    const config = ctx.executor.readFile(configFile);
    if (!config) return `dnsmasq: failed to read ${configFile}`;

    // addn-hosts=<file> pulls extra records from a /etc/hosts-style file
    const hostsMatch = config.match(/addn-hosts=(\S+)/);
    if (hostsMatch) {
      const hostsContent = ctx.executor.readFile(hostsMatch[1]);
      if (hostsContent) {
        ctx.dnsService.parseHostsFile(hostsContent);
      }
    }

    ctx.dnsService.parseConfig(config);
    ctx.dnsService.start();
    return '';
  },
};

import type { LinuxCommand } from '../LinuxCommand';

export const firewallCmdCommand: LinuxCommand = {
  name: 'firewall-cmd',
  package: 'firewalld',
  needsNetworkContext: true,
  usage: 'firewall-cmd [options]',
  run(): string {
    return 'firewall-cmd: command not found (firewalld is not simulated in this environment; use iptables/ufw)';
  },
};

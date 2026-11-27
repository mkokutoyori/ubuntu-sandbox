import type { Equipment } from '@/network';
import type { LabWorkbench } from '../LabWorkbench';

export async function configureLinux(
  bench: LabWorkbench, device: Equipment, address: string, prefix: number, gateway: string, dnsServers: readonly string[], hostname: string,
): Promise<void> {
  await bench.shell(device, `sudo hostnamectl set-hostname ${hostname}`);
  await bench.writeFile(device, '/etc/netplan/01-lab.yaml', [
    'network:',
    '  version: 2',
    '  ethernets:',
    '    eth0:',
    '      dhcp4: false',
    `      addresses: [${address}/${prefix}]`,
    '      routes:',
    '        - to: default',
    `          via: ${gateway}`,
    '      nameservers:',
    `        addresses: [${dnsServers.join(', ')}]`,
  ].join('\n'), '600');
  await bench.shell(device, 'sudo netplan apply');
}

export async function configureWindows(
  bench: LabWorkbench, device: Equipment, address: string, prefix: number, gateway: string, dnsServers: readonly string[], hostname: string,
): Promise<void> {
  await bench.powershell(
    device,
    `Rename-Computer -NewName ${hostname} -Force`,
    `New-NetIPAddress -InterfaceAlias "Ethernet 0" -IPAddress ${address} -PrefixLength ${prefix} -DefaultGateway ${gateway}`,
    `Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses ${dnsServers.join(',')}`,
  );
}

export async function forwardSyslog(bench: LabWorkbench, device: Equipment, logServer: string, port: number): Promise<void> {
  await bench.writeFile(device, '/etc/rsyslog.d/90-forward-lumiere.conf', `*.* @${logServer}:${port}`);
  await bench.shell(device, 'sudo systemctl restart rsyslog');
}

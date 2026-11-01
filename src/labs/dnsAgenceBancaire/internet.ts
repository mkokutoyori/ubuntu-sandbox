import type { Equipment } from '@/network';
import type { LabWorkbench } from '../LabWorkbench';
import {
  BANK_NAMED_CONF, BANK_REVERSE_ZONE, BANK_ZONE, ROOT_NAMED_CONF, ROOT_ZONE,
} from './dnsData';
import { PLAN, PUBLIC_DOMAIN, PUBLIC_LABEL, type HostPlan } from './plan';

export interface InternetDevices {
  readonly ispRouter: Equipment;
  readonly infraSwitch: Equipment;
  readonly hostingSwitch: Equipment;
  readonly rootNs: Equipment;
  readonly tldNs: Equipment;
  readonly ns1Bank: Equipment;
  readonly ns2Bank: Equipment;
  readonly webBank: Equipment;
}

export async function configureLinuxHost(bench: LabWorkbench, device: Equipment, plan: HostPlan, dnsServer: string): Promise<void> {
  const routes = plan.gateway === null ? [] : ['      routes:', '        - to: default', `          via: ${plan.gateway}`];
  await bench.writeFile(device, '/etc/netplan/01-lab.yaml', [
    'network:',
    '  version: 2',
    '  ethernets:',
    '    eth0:',
    '      dhcp4: false',
    `      addresses: [${plan.address}/${plan.mask.toCIDR()}]`,
    ...routes,
    '      nameservers:',
    `        addresses: [${dnsServer}]`,
  ].join('\n'), '600');
  await bench.shell(device, 'sudo netplan apply');
}

export async function configureWindowsHost(bench: LabWorkbench, device: Equipment, plan: HostPlan, dnsServer: string): Promise<void> {
  const gateway = plan.gateway === null ? '' : ` -DefaultGateway ${plan.gateway}`;
  await bench.powershell(
    device,
    `New-NetIPAddress -InterfaceAlias "Ethernet 0" -IPAddress ${plan.address} -PrefixLength ${plan.mask.toCIDR()}${gateway}`,
    `Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses ${dnsServer}`,
  );
}

export async function buildInternet(bench: LabWorkbench): Promise<InternetDevices> {
  const ispRouter = bench.place('router-cisco', 'R-ISP', 520, 40);
  const infraSwitch = bench.place('switch-generic', 'SW-INFRA', 300, 40);
  const hostingSwitch = bench.place('switch-generic', 'SW-HEBERGEMENT', 740, 40);
  const rootNs = bench.place('linux-server', PLAN.rootNs.name, 200, 160);
  const tldNs = bench.place('windows-server', PLAN.tldNs.name, 400, 160);
  const ns1Bank = bench.place('linux-server', PLAN.ns1Bank.name, 640, 160);
  const ns2Bank = bench.place('windows-server', PLAN.ns2Bank.name, 780, 160);
  const webBank = bench.place('linux-server', PLAN.webBank.name, 920, 160);

  bench.connect(ispRouter, 'GigabitEthernet0/0', infraSwitch, 'eth0');
  bench.connect(rootNs, 'eth0', infraSwitch, 'eth1');
  bench.connect(tldNs, 'eth0', infraSwitch, 'eth2');
  bench.connect(ispRouter, 'GigabitEthernet0/1', hostingSwitch, 'eth0');
  bench.connect(ns1Bank, 'eth0', hostingSwitch, 'eth1');
  bench.connect(ns2Bank, 'eth0', hostingSwitch, 'eth2');
  bench.connect(webBank, 'eth0', hostingSwitch, 'eth3');

  await bench.shell(
    ispRouter,
    'enable', 'configure terminal', 'hostname R-ISP',
    'interface GigabitEthernet0/0', 'description DNS-INFRA racine et TLD',
    `ip address ${PLAN.ispInfra} 255.255.255.0`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'description HEBERGEMENT serveurs de la banque',
    `ip address ${PLAN.ispHosting} 255.255.255.0`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', 'description LIEN VERS AGENCE',
    `ip address ${PLAN.ispAgencyLink} 255.255.255.252`, 'no shutdown', 'end',
    'write memory',
  );

  await configureLinuxHost(bench, rootNs, PLAN.rootNs, '127.0.0.1');
  await bench.shell(rootNs, 'sudo apt install -y bind9');
  await bench.writeFile(rootNs, '/etc/bind/named.conf', ROOT_NAMED_CONF);
  await bench.writeFile(rootNs, '/etc/bind/db.root', ROOT_ZONE);
  await bench.shell(rootNs, 'sudo systemctl restart named');

  await configureWindowsHost(bench, tldNs, PLAN.tldNs, '127.0.0.1');
  await bench.powershell(
    tldNs,
    'Install-WindowsFeature DNS -IncludeManagementTools',
    'Set-DnsServerRecursion -Enable $false',
    'Add-DnsServerPrimaryZone -Name com -ZoneFile com.dns',
    'Add-DnsServerResourceRecord -NS -ZoneName com -Name "@" -NameServer a.nic.com',
    `Add-DnsServerResourceRecordA -ZoneName com -Name a.nic -IPv4Address ${PLAN.tldNs.address}`,
    `Add-DnsServerZoneDelegation -Name com -ChildZoneName ${PUBLIC_LABEL} -NameServer ns1.${PUBLIC_DOMAIN} -IPAddress ${PLAN.ns1Bank.address}`,
    `Add-DnsServerZoneDelegation -Name com -ChildZoneName ${PUBLIC_LABEL} -NameServer ns2.${PUBLIC_DOMAIN} -IPAddress ${PLAN.ns2Bank.address}`,
  );

  await configureLinuxHost(bench, ns1Bank, PLAN.ns1Bank, '127.0.0.1');
  await bench.shell(ns1Bank, 'sudo apt install -y bind9');
  await bench.writeFile(ns1Bank, '/etc/bind/named.conf', BANK_NAMED_CONF);
  await bench.writeFile(ns1Bank, `/etc/bind/db.${PUBLIC_DOMAIN}`, BANK_ZONE);
  await bench.writeFile(ns1Bank, '/etc/bind/db.203.0.113', BANK_REVERSE_ZONE);
  await bench.shell(ns1Bank, 'sudo systemctl restart named');

  await configureWindowsHost(bench, ns2Bank, PLAN.ns2Bank, '127.0.0.1');
  await bench.powershell(
    ns2Bank,
    'Install-WindowsFeature DNS -IncludeManagementTools',
    'Set-DnsServerRecursion -Enable $false',
    `Add-DnsServerSecondaryZone -Name ${PUBLIC_DOMAIN} -ZoneFile ${PUBLIC_DOMAIN}.dns -MasterServers ${PLAN.ns1Bank.address}`,
    `Add-DnsServerSecondaryZone -Name 113.0.203.in-addr.arpa -ZoneFile 113.0.203.in-addr.arpa.dns -MasterServers ${PLAN.ns1Bank.address}`,
  );

  return { ispRouter, infraSwitch, hostingSwitch, rootNs, tldNs, ns1Bank, ns2Bank, webBank };
}

import type { Equipment } from '@/network';
import type { LabWorkbench } from '../LabWorkbench';
import { RESOLVER_NAMED_CONF, ROOT_HINTS } from './dnsData';
import { configureLinuxHost, configureWindowsHost } from './internet';
import { INTERNAL_DOMAIN, PLAN } from './plan';

export interface AgencyDevices {
  readonly edgeRouter: Equipment;
  readonly agencySwitch: Equipment;
  readonly dc1: Equipment;
  readonly dnsRes: Equipment;
  readonly guichet1: Equipment;
  readonly guichet2: Equipment;
  readonly conseiller: Equipment;
}

export async function buildAgency(bench: LabWorkbench, ispRouter: Equipment): Promise<AgencyDevices> {
  const edgeRouter = bench.place('router-cisco', 'R-AGENCE', 520, 300);
  const agencySwitch = bench.place('switch-cisco', 'SW-AGENCE', 520, 420);
  const dc1 = bench.place('windows-server', PLAN.dc1.name, 300, 560);
  const dnsRes = bench.place('linux-server', PLAN.dnsRes.name, 460, 560);
  const guichet1 = bench.place('windows-pc', 'PC-GUICHET1', 620, 560);
  const guichet2 = bench.place('windows-pc', 'PC-GUICHET2', 780, 560);
  const conseiller = bench.place('linux-pc', 'PC-CONSEILLER', 940, 560);

  bench.connect(edgeRouter, 'GigabitEthernet0/0', ispRouter, 'GigabitEthernet0/2');
  bench.connect(edgeRouter, 'GigabitEthernet0/1', agencySwitch, 'FastEthernet0/1');
  bench.connect(dc1, 'eth0', agencySwitch, 'FastEthernet0/2');
  bench.connect(dnsRes, 'eth0', agencySwitch, 'FastEthernet0/3');
  bench.connect(guichet1, 'eth0', agencySwitch, 'FastEthernet0/4');
  bench.connect(guichet2, 'eth0', agencySwitch, 'FastEthernet0/5');
  bench.connect(conseiller, 'eth0', agencySwitch, 'FastEthernet0/6');

  await bench.shell(
    agencySwitch,
    'enable', 'configure terminal', 'hostname SW-AGENCE',
    'vlan 10', 'name POSTES', 'exit',
    'vlan 20', 'name SERVEURS', 'exit',
    'interface FastEthernet0/1', 'description TRUNK vers R-AGENCE',
    'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'exit',
    'interface FastEthernet0/2', 'description DC1', 'switchport mode access', 'switchport access vlan 20', 'exit',
    'interface FastEthernet0/3', 'description DNS-RES', 'switchport mode access', 'switchport access vlan 20', 'exit',
    'interface range FastEthernet0/4 - 6', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'end', 'write memory',
  );

  await bench.shell(
    edgeRouter,
    'enable', 'configure terminal', 'hostname R-AGENCE',
    'interface GigabitEthernet0/0', 'description WAN vers R-ISP',
    `ip address ${PLAN.agencyWan} 255.255.255.252`, 'ip nat outside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'description LAN agence', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1.10', 'description VLAN10 POSTES', 'encapsulation dot1Q 10',
    `ip address ${PLAN.agencyPostes} 255.255.255.0`, `ip helper-address ${PLAN.dc1.address}`, 'ip nat inside', 'exit',
    'interface GigabitEthernet0/1.20', 'description VLAN20 SERVEURS', 'encapsulation dot1Q 20',
    `ip address ${PLAN.agencyServeurs} 255.255.255.0`, 'ip nat inside', 'exit',
    'access-list 1 permit 10.20.0.0 0.0.255.255',
    'ip nat inside source list 1 interface GigabitEthernet0/0 overload',
    `ip route 0.0.0.0 0.0.0.0 ${PLAN.ispAgencyLink}`,
    'end', 'write memory',
  );

  await configureWindowsHost(bench, dc1, PLAN.dc1, '127.0.0.1');
  await bench.powershell(
    dc1,
    'Install-WindowsFeature DNS -IncludeManagementTools',
    'Install-WindowsFeature DHCP -IncludeManagementTools',
    `Add-DnsServerPrimaryZone -Name ${INTERNAL_DOMAIN} -ZoneFile ${INTERNAL_DOMAIN}.dns -DynamicUpdate NonsecureAndSecure`,
    'Add-DnsServerPrimaryZone -NetworkId 10.20.0.0/16 -ZoneFile 20.10.in-addr.arpa.dns -DynamicUpdate NonsecureAndSecure',
    `Add-DnsServerResourceRecordA -ZoneName ${INTERNAL_DOMAIN} -Name dc1 -IPv4Address ${PLAN.dc1.address} -CreatePtr`,
    `Add-DnsServerResourceRecordA -ZoneName ${INTERNAL_DOMAIN} -Name dns-res -IPv4Address ${PLAN.dnsRes.address} -CreatePtr`,
    `Add-DnsServerResourceRecordCName -ZoneName ${INTERNAL_DOMAIN} -Name intranet -HostNameAlias dc1.${INTERNAL_DOMAIN}`,
    `Set-DnsServerForwarder -IPAddress ${PLAN.dnsRes.address}`,
    'Add-DhcpServerv4Scope -Name POSTES -StartRange 10.20.10.50 -EndRange 10.20.10.200 -SubnetMask 255.255.255.0',
    `Set-DhcpServerv4OptionValue -ScopeId 10.20.10.0 -Router ${PLAN.agencyPostes} -DnsServer ${PLAN.dc1.address},${PLAN.dnsRes.address} -DnsDomain ${INTERNAL_DOMAIN}`,
    'Set-DhcpServerv4DnsSetting -ScopeId 10.20.10.0 -DynamicUpdates Always',
  );

  await configureLinuxHost(bench, dnsRes, PLAN.dnsRes, '127.0.0.1');
  await bench.shell(dnsRes, 'sudo apt install -y bind9');
  await bench.writeFile(dnsRes, '/etc/bind/named.conf', RESOLVER_NAMED_CONF);
  await bench.writeFile(dnsRes, '/etc/bind/db.root.hints', ROOT_HINTS);
  await bench.shell(dnsRes, 'sudo systemctl restart named');

  await bench.powershell(guichet1, 'ipconfig /renew');
  await bench.powershell(guichet2, 'ipconfig /renew');
  await bench.writeFile(conseiller, '/etc/netplan/01-lab.yaml', [
    'network:',
    '  version: 2',
    '  ethernets:',
    '    eth0:',
    '      dhcp4: true',
  ].join('\n'), '600');
  await bench.shell(conseiller, 'sudo netplan apply');

  return { edgeRouter, agencySwitch, dc1, dnsRes, guichet1, guichet2, conseiller };
}

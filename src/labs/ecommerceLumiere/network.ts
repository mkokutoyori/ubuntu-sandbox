import type { Equipment } from '@/network';
import type { LabWorkbench } from '../LabWorkbench';
import { AGENCIES, DR, DR_TUNNEL, HQ, INTERNET, PRE_SHARED_KEY, type Agency } from './plan';

const phase1 = (name: string, remoteGateway: string): string[] => [
  'config vpn ipsec phase1-interface', `edit "${name}"`,
  'set interface "wan1"', 'set ike-version 2', `set remote-gw ${remoteGateway}`,
  `set psksecret ${PRE_SHARED_KEY}`, 'set proposal aes256-sha256', 'set dhgrp 14', 'next', 'end',
];

const phase2 = (name: string): string[] => [
  'config vpn ipsec phase2-interface', `edit "${name}"`,
  `set phase1name "${name}"`, 'set proposal aes256-sha256',
  'set src-subnet 0.0.0.0 0.0.0.0', 'set dst-subnet 0.0.0.0 0.0.0.0', 'next', 'end',
];

const portBlock = (port: string, address: string, mask = '255.255.255.0'): string[] => {
  const wan = port === 'wan1' || port === 'wan2';
  return [
    'config system interface', `edit ${port}`, 'set mode static', `set ip ${address} ${mask}`,
    `set allowaccess ${wan ? 'ping' : 'ping https ssh'}`, 'next', 'end',
  ];
};

const policy = (id: number, name: string, source: string, destination: string, extra: string[] = []): string[] => [
  'config firewall policy', `edit ${id}`, `set name "${name}"`,
  `set srcintf "${source}"`, `set dstintf "${destination}"`,
  'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"', ...extra,
  'next', 'end',
];

const staticRoute = (id: number, destination: string, mask: string, device: string, gateway?: string): string[] => [
  'config router static', `edit ${id}`, `set dst ${destination} ${mask}`,
  ...(gateway === undefined ? [] : [`set gateway ${gateway}`]), `set device "${device}"`, 'next', 'end',
];

const syslog = (server: string): string[] => [
  'config log syslogd setting', 'set status enable', `set server "${server}"`, 'set facility local7', 'set format default', 'end',
  'config log syslogd filter', 'set severity information', 'set forward-traffic enable', 'end',
  'config log setting', 'set fwpolicy-implicit-log enable', 'end',
];

export async function configureIsp(bench: LabWorkbench, isp: Equipment): Promise<void> {
  await bench.shell(
    isp, 'enable', 'configure terminal', 'hostname R-ISP',
    'interface GigabitEthernet0/0', `ip address ${INTERNET.gateway} 255.255.255.0`, 'description vers-Internet-operateurs', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', `ip address ${INTERNET.externalGateway} 255.255.255.0`, 'description vers-reseau-clients', 'no shutdown', 'exit',
    'end',
  );
}

export async function configureFortiGateHq(bench: LabWorkbench, fgt: Equipment, syslogServer: string): Promise<void> {
  await bench.shell(
    fgt,
    'config system global', 'set hostname FGT-HQ', 'end',
    ...portBlock('wan1', INTERNET.fgtHq), ...portBlock('port1', HQ.fgtTransit, '255.255.255.252'), ...portBlock('port2', HQ.dmz.gateway),
    ...staticRoute(1, '10.10.0.0', '255.255.0.0', 'port1', HQ.routerTransit),
    ...staticRoute(2, '0.0.0.0', '0.0.0.0', 'wan1', INTERNET.gateway),
    ...syslog(syslogServer),
  );
  const spokes: { tunnel: string; wan: string; network: string; mask: string; id: number }[] = [
    { tunnel: DR_TUNNEL, wan: INTERNET.fgtDr, network: '10.20.0.0', mask: '255.255.0.0', id: 10 },
    ...AGENCIES.map((agency, index) => ({ tunnel: agency.tunnel, wan: agency.wan, network: agency.network, mask: '255.255.255.0', id: 11 + index })),
  ];
  for (const spoke of spokes) {
    await bench.shell(fgt, ...phase1(spoke.tunnel, spoke.wan), ...phase2(spoke.tunnel), ...staticRoute(spoke.id, spoke.network, spoke.mask, spoke.tunnel));
  }
  await bench.shell(fgt, ...staticRoute(20, '172.17.10.0', '255.255.255.0', DR_TUNNEL));
  await bench.shell(
    fgt,
    'config firewall vip',
    'edit "vip-web"', `set extip ${INTERNET.vipWeb}`, `set mappedip "${HQ.dmz.web1}"`, 'set extintf "wan1"',
    'set portforward enable', 'set protocol tcp', 'set extport 80', 'set mappedport 80', 'next',
    'edit "vip-web-https"', 'set type server-load-balance', 'set server-type https',
    `set extip ${INTERNET.vipWeb}`, 'set extintf "wan1"', 'set extport 443',
    'set ssl-mode half', 'set ssl-certificate "Fortinet_Factory"',
    'config realservers', 'edit 1', `set ip ${HQ.dmz.web1}`, 'set port 80', 'next', 'edit 2', `set ip ${HQ.dmz.web2}`, 'set port 80', 'next', 'end', 'next',
    'end',
    'config firewall policy',
    'edit 10', 'set name "internet-to-web"', 'set srcintf "wan1"', 'set dstintf "port2"', 'set srcaddr "all"',
    'set dstaddr "vip-web"', 'set service "HTTP"', 'set action accept', 'set schedule "always"', 'next',
    'edit 11', 'set name "internet-to-web-https"', 'set srcintf "wan1"', 'set dstintf "port2"', 'set srcaddr "all"',
    'set dstaddr "vip-web-https"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next',
    'end',
    ...policy(20, 'inside-to-internet', 'port1', 'wan1', ['set nat enable']),
    ...policy(21, 'dmz-to-internet', 'port2', 'wan1', ['set nat enable']),
    ...policy(22, 'inside-to-dmz', 'port1', 'port2'),
    ...policy(23, 'dmz-to-inside', 'port2', 'port1'),
  );
  for (const spoke of spokes) {
    await bench.shell(
      fgt,
      ...policy(30 + spoke.id, `inside-to-${spoke.tunnel}`, 'port1', spoke.tunnel),
      ...policy(40 + spoke.id, `${spoke.tunnel}-to-inside`, spoke.tunnel, 'port1'),
      ...policy(50 + spoke.id, `dmz-to-${spoke.tunnel}`, 'port2', spoke.tunnel),
      ...policy(60 + spoke.id, `${spoke.tunnel}-to-dmz`, spoke.tunnel, 'port2'),
    );
    for (const other of spokes) {
      if (other === spoke) continue;
      await bench.shell(fgt, ...policy(100 + spoke.id * 10 + other.id % 10, `${spoke.tunnel}-to-${other.tunnel}`, spoke.tunnel, other.tunnel));
    }
  }
}

export async function configureFortiGateDr(bench: LabWorkbench, fgt: Equipment, syslogServer: string): Promise<void> {
  await bench.shell(
    fgt,
    'config system global', 'set hostname FGT-DR', 'end',
    ...portBlock('wan1', INTERNET.fgtDr), ...portBlock('port1', DR.fgtTransit, '255.255.255.252'), ...portBlock('port2', DR.dmz.gateway),
    ...staticRoute(1, '10.20.0.0', '255.255.0.0', 'port1', DR.routerTransit),
    ...staticRoute(6, '0.0.0.0', '0.0.0.0', 'wan1', INTERNET.gateway),
    ...phase1(DR_TUNNEL, INTERNET.fgtHq), ...phase2(DR_TUNNEL),
    ...staticRoute(2, '10.10.0.0', '255.255.0.0', DR_TUNNEL), ...staticRoute(3, '172.16.10.0', '255.255.255.0', DR_TUNNEL),
    ...staticRoute(4, '10.1.0.0', '255.255.255.0', DR_TUNNEL), ...staticRoute(5, '10.2.0.0', '255.255.255.0', DR_TUNNEL),
    ...syslog(syslogServer),
    ...policy(1, 'inside-to-hq', 'port1', DR_TUNNEL), ...policy(2, 'hq-to-inside', DR_TUNNEL, 'port1'),
    ...policy(3, 'dmz-to-hq', 'port2', DR_TUNNEL), ...policy(4, 'hq-to-dmz', DR_TUNNEL, 'port2'),
    ...policy(5, 'inside-to-internet', 'port1', 'wan1', ['set nat enable']),
    ...policy(6, 'dmz-to-internet', 'port2', 'wan1', ['set nat enable']),
    ...policy(7, 'inside-to-dmz', 'port1', 'port2'), ...policy(8, 'dmz-to-inside', 'port2', 'port1'),
  );
}

export async function configureFortiGateAgency(bench: LabWorkbench, fgt: Equipment, agency: Agency, syslogServer: string): Promise<void> {
  await bench.shell(
    fgt,
    'config system global', `set hostname FGT-${agency.name}`, 'end',
    ...portBlock('wan1', agency.wan), ...portBlock('port1', agency.gateway),
    ...phase1('to-hq', INTERNET.fgtHq), ...phase2('to-hq'),
    ...staticRoute(1, '10.0.0.0', '255.0.0.0', 'to-hq'), ...staticRoute(2, '172.16.0.0', '255.254.0.0', 'to-hq'),
    ...staticRoute(3, '0.0.0.0', '0.0.0.0', 'wan1', INTERNET.gateway),
    ...syslog(syslogServer),
    ...policy(1, 'lan-to-hq', 'port1', 'to-hq'), ...policy(2, 'hq-to-lan', 'to-hq', 'port1'),
    ...policy(3, 'lan-to-internet', 'port1', 'wan1', ['set nat enable']),
  );
}

export async function configureHqRouter(bench: LabWorkbench, router: Equipment, helper: string, syslogServer: string): Promise<void> {
  await bench.shell(
    router, 'enable', 'configure terminal', 'hostname R-HQ',
    'interface GigabitEthernet0/0', `ip address ${HQ.routerTransit} 255.255.255.252`, 'description transit-FGT-HQ', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', `ip address ${HQ.servers.gateway} 255.255.255.0`, 'description reseau-serveurs', 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', `ip address ${HQ.users.gateway} 255.255.255.0`, 'description reseau-utilisateurs', `ip helper-address ${helper}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/3', `ip address ${HQ.db.gateway} 255.255.255.0`, 'description zone-bases-de-donnees', 'no shutdown', 'exit',
    `ip route 0.0.0.0 0.0.0.0 ${HQ.fgtTransit}`,
    `logging host ${syslogServer}`, 'logging trap informational', 'service timestamps log datetime msec',
    'end',
  );
}

export async function configureDrRouter(bench: LabWorkbench, router: Equipment, syslogServer: string): Promise<void> {
  await bench.shell(
    router, 'system-view', 'sysname R-DR',
    'interface GigabitEthernet0/0/0', `ip address ${DR.routerTransit} 255.255.255.252`, 'description transit-FGT-DR', 'undo shutdown', 'quit',
    'interface GigabitEthernet0/0/1', `ip address ${DR.servers.gateway} 255.255.255.0`, 'description reseau-serveurs-DR', 'undo shutdown', 'quit',
    'interface GigabitEthernet0/0/2', `ip address ${DR.db.gateway} 255.255.255.0`, 'description zone-bases-de-donnees-DR', 'undo shutdown', 'quit',
    `ip route-static 0.0.0.0 0.0.0.0 ${DR.fgtTransit}`,
    'return',
  );
  void syslogServer;
}

export async function configureCiscoSwitch(bench: LabWorkbench, device: Equipment, hostname: string, vlan: number, vlanName: string, accessPorts: readonly string[]): Promise<void> {
  await bench.shell(
    device, 'enable', 'configure terminal', `hostname ${hostname}`,
    `vlan ${vlan}`, `name ${vlanName}`, 'exit',
    ...accessPorts.flatMap((port) => [`interface ${port}`, 'switchport mode access', `switchport access vlan ${vlan}`, 'spanning-tree portfast', 'exit']),
    'end',
  );
}

export async function configureHuaweiSwitch(bench: LabWorkbench, device: Equipment, hostname: string, vlan: number, accessPorts: readonly string[]): Promise<void> {
  await bench.shell(
    device, 'system-view', `sysname ${hostname}`, `vlan ${vlan}`, 'quit',
    ...accessPorts.flatMap((port) => [`interface ${port}`, 'port link-type access', `port default vlan ${vlan}`, 'quit']),
    'return',
  );
}

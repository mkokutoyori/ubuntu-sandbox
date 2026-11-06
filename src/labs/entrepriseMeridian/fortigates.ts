import type { Equipment } from '@/network';
import type { LabWorkbench } from '../LabWorkbench';
import { HQ, PRE_SHARED_KEY, SITES, type Site } from './plan';

const tunnelPhase1 = (name: string, remoteGateway: string): string[] => [
  'config vpn ipsec phase1-interface', `edit "${name}"`,
  'set interface "wan1"', 'set ike-version 2', `set remote-gw ${remoteGateway}`,
  `set psksecret ${PRE_SHARED_KEY}`, 'set proposal aes256-sha256', 'set dhgrp 14', 'next', 'end',
];

const tunnelPhase2 = (name: string, source: string, destination: string): string[] => [
  'config vpn ipsec phase2-interface', `edit "${name}"`,
  `set phase1name "${name}"`, 'set proposal aes256-sha256',
  `set src-subnet ${source}`, `set dst-subnet ${destination}`, 'next', 'end',
];

const interfaceBlock = (port: string, address: string, extra: string[] = []): string[] => {
  const wan = port === 'wan1' || port === 'wan2';
  return [
    'config system interface', `edit ${port}`, 'set mode static', `set ip ${address} 255.255.255.0`,
    `set allowaccess ${wan ? 'ping' : 'ping https ssh'}`, ...extra, 'next', 'end',
  ];
};

const policy = (id: number, name: string, source: string, destination: string, extra: string[] = []): string[] => [
  'config firewall policy', `edit ${id}`, `set name "${name}"`,
  `set srcintf "${source}"`, `set dstintf "${destination}"`,
  'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"', ...extra,
  'next', 'end',
];

export async function configureHeadquarters(bench: LabWorkbench, hq: Equipment): Promise<void> {
  await bench.shell(
    hq,
    'config system global', 'set hostname FGT-HQ', 'end',
    ...interfaceBlock('wan1', `${HQ.wan}`),
    ...interfaceBlock('port1', HQ.lanGateway),
    ...interfaceBlock('port2', HQ.dmzGateway),
  );
  await bench.shell(
    hq,
    'config firewall DoS-policy', 'edit 1', 'set comments "wan-flood-protection"', 'set interface "wan1"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'config anomaly',
    'edit "icmp_flood"', 'set status enable', 'set action block', 'set threshold 50', 'next',
    'edit "tcp_syn_flood"', 'set status enable', 'set action block', 'set threshold 500', 'next',
    'end', 'next', 'end',
  );
  for (const site of SITES) {
    await bench.shell(
      hq,
      ...tunnelPhase1(site.tunnelOnHub, site.wan),
      ...tunnelPhase2(site.tunnelOnHub, '0.0.0.0 0.0.0.0', '0.0.0.0 0.0.0.0'),
      'config router static', `edit ${100 + SITES.indexOf(site)}`,
      `set dst ${site.lanRoute}`, `set device "${site.tunnelOnHub}"`, 'next', 'end',
    );
  }
  await bench.shell(
    hq,
    'config firewall vip',
    'edit "vip-web"', `set extip ${HQ.wanVip.web}`, `set mappedip "${HQ.web}"`, 'set extintf "wan1"',
    'set portforward enable', 'set protocol tcp', 'set extport 80', 'set mappedport 80', 'next',
    'edit "vip-mail"', `set extip ${HQ.wanVip.mail}`, `set mappedip "${HQ.mail}"`, 'set extintf "wan1"',
    'set portforward enable', 'set protocol tcp', 'set extport 25', 'set mappedport 25', 'next',
    'end',
    'config firewall policy',
    'edit 10', 'set name "internet-to-web"', 'set srcintf "wan1"', 'set dstintf "port2"', 'set srcaddr "all"',
    'set dstaddr "vip-web"', 'set service "HTTP"', 'set action accept', 'set schedule "always"', 'next',
    'edit 11', 'set name "internet-to-mail"', 'set srcintf "wan1"', 'set dstintf "port2"', 'set srcaddr "all"',
    'set dstaddr "vip-mail"', 'set service "SMTP"', 'set action accept', 'set schedule "always"', 'next',
    'end',
    ...policy(20, 'lan-to-internet', 'port1', 'wan1', ['set nat enable']),
    ...policy(21, 'dmz-to-internet', 'port2', 'wan1', ['set nat enable']),
    ...policy(22, 'lan-to-dmz', 'port1', 'port2'),
    ...policy(23, 'dmz-to-lan', 'port2', 'port1'),
  );
  for (const site of SITES) {
    await bench.shell(
      hq,
      ...policy(30 + SITES.indexOf(site) * 10, `lan-to-${site.tunnelOnHub}`, 'port1', site.tunnelOnHub),
      ...policy(31 + SITES.indexOf(site) * 10, `${site.tunnelOnHub}-to-lan`, site.tunnelOnHub, 'port1'),
      ...policy(32 + SITES.indexOf(site) * 10, `${site.tunnelOnHub}-to-dmz`, site.tunnelOnHub, 'port2'),
    );
    for (const other of SITES) {
      if (other === site) continue;
      await bench.shell(
        hq,
        ...policy(100 + SITES.indexOf(site) * 10 + SITES.indexOf(other), `${site.tunnelOnHub}-to-${other.tunnelOnHub}`, site.tunnelOnHub, other.tunnelOnHub),
      );
    }
  }
}

export async function configureAgency(bench: LabWorkbench, fortigate: Equipment, site: Site): Promise<void> {
  await bench.shell(
    fortigate,
    'config system global', `set hostname FGT-${site.name}`, 'end',
    ...interfaceBlock('wan1', site.wan),
    ...interfaceBlock('port1', site.lanGateway),
    ...tunnelPhase1(site.tunnelOnSpoke, HQ.wan),
    ...tunnelPhase2(site.tunnelOnSpoke, site.lanRoute, '0.0.0.0 0.0.0.0'),
    'config router static',
    'edit 1', 'set dst 10.0.0.0 255.0.0.0', `set device "${site.tunnelOnSpoke}"`, 'next',
    'edit 2', 'set dst 172.16.0.0 255.255.255.0', `set device "${site.tunnelOnSpoke}"`, 'next',
    'end',
    ...policy(1, 'lan-to-hq', 'port1', site.tunnelOnSpoke),
    ...policy(2, 'hq-to-lan', site.tunnelOnSpoke, 'port1'),
    ...policy(3, 'lan-to-internet', 'port1', 'wan1', ['set nat enable']),
  );
}

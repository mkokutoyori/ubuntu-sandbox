import type { Equipment } from '@/network';
import type { LabWorkbench } from '../LabWorkbench';
import { GUEST, HQ, OVERLAY, POST_QUANTUM_KEY, PRE_SHARED_KEY, SITES, type Site } from './plan';

const INTERNET_NETWORK = '203.0.113.0';

const tunnelPhase1 = (name: string, remoteGateway: string): string[] => [
  'config vpn ipsec phase1-interface', `edit "${name}"`,
  'set interface "wan1"', 'set ike-version 2', `set remote-gw ${remoteGateway}`,
  `set psksecret ${PRE_SHARED_KEY}`, 'set proposal aes256-sha256', 'set dhgrp 14',
  'set ppk require', `set ppk-identity "${POST_QUANTUM_KEY.identity}"`, `set ppk-secret ${POST_QUANTUM_KEY.secret}`, 'next', 'end',
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

const overlay = (remoteGateway: string, address: string): string[] => [
  'config system vxlan', `edit "${OVERLAY.device}"`, 'set interface "wan1"', `set vni ${OVERLAY.vni}`,
  `set remote-ip "${remoteGateway}"`, 'next', 'end',
  ...interfaceBlock(OVERLAY.device, address, ['set allowaccess ping']),
];

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
    ...interfaceBlock('port3', GUEST.gateway, [`set vrf ${GUEST.vrf}`, 'set allowaccess ping']),
    'config router prefix-list', 'edit "internet-only"', 'config rule', 'edit 1',
    `set prefix ${INTERNET_NETWORK} 255.255.255.0`, 'set action permit', 'next', 'end', 'next', 'end',
    'config router route-map', 'edit "leak-internet"', 'config rule', 'edit 1', 'set match-ip-address "internet-only"', 'next', 'end', 'next', 'end',
    'config router bgp', 'set as 65000',
    'config vrf', 'edit 0', 'config leak-target', `edit ${GUEST.vrf}`, 'set interface "wan1"', 'set route-map "leak-internet"', 'next', 'end', 'next', 'end',
    'end',
  );
  await bench.shell(
    hq,
    'config log syslogd setting', 'set status enable', `set server "${HQ.siem}"`, 'set facility local7',
    'set format default', 'end',
    'config log syslogd filter', 'set severity information', 'set forward-traffic enable', 'end',
    'config log setting', 'set fwpolicy-implicit-log enable', 'end',
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
  await bench.shell(hq, ...overlay(SITES[0].wan, OVERLAY.hub));
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
    'edit "vip-web-https"', 'set type server-load-balance', 'set server-type https',
    `set extip ${HQ.wanVip.web}`, 'set extintf "wan1"', 'set extport 443',
    'set ssl-mode half', 'set ssl-certificate "Fortinet_Factory"',
    'config realservers', 'edit 1', `set ip ${HQ.web}`, 'set port 80', 'next', 'end', 'next',
    'end',
    'config firewall policy',
    'edit 10', 'set name "internet-to-web"', 'set srcintf "wan1"', 'set dstintf "port2"', 'set srcaddr "all"',
    'set dstaddr "vip-web"', 'set service "HTTP"', 'set action accept', 'set schedule "always"', 'next',
    'edit 12', 'set name "internet-to-web-https"', 'set srcintf "wan1"', 'set dstintf "port2"', 'set srcaddr "all"',
    'set dstaddr "vip-web-https"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next',
    'edit 11', 'set name "internet-to-mail"', 'set srcintf "wan1"', 'set dstintf "port2"', 'set srcaddr "all"',
    'set dstaddr "vip-mail"', 'set service "SMTP"', 'set action accept', 'set schedule "always"', 'next',
    'end',
    'config ips custom', 'edit "Meridian.Injection"',
    `set signature 'F-SBID( --name "Meridian.Injection"; --protocol tcp; --service HTTP; --flow from_client; --pattern "1=1"; --context uri; --no_case; --severity high; )'`,
    'set action block', 'next', 'end',
    'config ips sensor', 'edit "web-protect"', 'config entries', 'edit 1', 'set severity high', 'next', 'end', 'next', 'end',
    'config firewall policy', 'edit 10', 'set utm-status enable', 'set inspection-mode flow', 'set ips-sensor "web-protect"', 'next', 'end',
    ...policy(20, 'lan-to-internet', 'port1', 'wan1', ['set nat enable']),
    ...policy(21, 'dmz-to-internet', 'port2', 'wan1', ['set nat enable']),
    ...policy(22, 'lan-to-dmz', 'port1', 'port2'),
    ...policy(23, 'dmz-to-lan', 'port2', 'port1'),
    ...policy(24, 'guest-to-internet', 'port3', 'wan1', ['set nat enable']),
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
    ...(site === SITES[0] ? overlay(HQ.wan, OVERLAY.spoke) : []),
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

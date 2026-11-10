import { loadDevicePlatform } from '@/network';
import type { Equipment } from '@/network';
import { useNetworkStore } from '@/store/networkStore';
import { LabWorkbench } from '../LabWorkbench';
import { configureAuditWorkstation } from './assessment';
import { configureAgency, configureHeadquarters } from './fortigates';
import { configureDomainController, configureSiem, joinDomainAndInstallExchange, configureLinux, configureWindows, publishWebSite } from './hosts';
import { AUDITOR, GUEST, HQ, INTERNET, INTERNAL_DOMAIN, SITES } from './plan';

export interface MeridianLab {
  readonly bench: LabWorkbench;
  readonly devices: ReadonlyMap<string, Equipment>;
}

export async function buildMeridian(): Promise<MeridianLab> {
  await loadDevicePlatform('firewall-fortinet');
  useNetworkStore.getState().clearAll();
  const bench = new LabWorkbench();
  const devices = new Map<string, Equipment>();
  const place = (type: Parameters<LabWorkbench['place']>[0], name: string, x: number, y: number): Equipment => {
    const device = bench.place(type, name, x, y);
    devices.set(name, device);
    return device;
  };

  const internet = place('switch-generic', 'SW-INTERNET', 520, 40);
  const webInet = place('linux-server', 'WEB-INTERNET', 760, 40);
  const visitor = place('linux-pc', 'PC-VISITEUR', 900, 40);
  const auditor = place('linux-pc', 'PC-AUDIT', 900, 120);
  const hq = place('firewall-fortinet', 'FGT-HQ', 520, 180);
  const swLan = place('switch-generic', 'SW-HQ-LAN', 300, 320);
  const swDmz = place('switch-generic', 'SW-HQ-DMZ', 700, 320);
  const dc1 = place('windows-server', 'DC1', 160, 460);
  const oracle = place('linux-server', 'ORA-DB', 300, 460);
  const workstation = place('linux-pc', 'PC-HQ', 440, 460);
  const siem = place('linux-server', 'SIEM', 220, 540);
  const web = place('linux-server', 'WEB-DMZ', 640, 460);
  const mail = place('windows-server', 'MAIL-DMZ', 780, 460);
  const guest = place('linux-pc', 'PC-INVITE', 520, 320);

  bench.connect(webInet, 'eth0', internet, 'eth0');
  bench.connect(visitor, 'eth0', internet, 'eth1');
  bench.connect(auditor, 'eth0', internet, 'eth6');
  bench.connect(hq, 'wan1', internet, 'eth2');
  bench.connect(hq, 'port1', swLan, 'eth0');
  bench.connect(hq, 'port2', swDmz, 'eth0');
  bench.connect(hq, 'port3', guest, 'eth0');
  bench.connect(dc1, 'eth0', swLan, 'eth1');
  bench.connect(oracle, 'eth0', swLan, 'eth2');
  bench.connect(workstation, 'eth0', swLan, 'eth3');
  bench.connect(siem, 'eth0', swLan, 'eth4');
  bench.connect(web, 'eth0', swDmz, 'eth1');
  bench.connect(mail, 'eth0', swDmz, 'eth2');

  const agencies = SITES.map((site, index) => {
    const fortigate = place('firewall-fortinet', `FGT-${site.name}`, 1000, 180 + index * 140);
    const client = place('linux-pc', `PC-${site.name}`, 1180, 180 + index * 140);
    bench.connect(fortigate, 'wan1', internet, `eth${3 + index}`);
    bench.connect(fortigate, 'port1', client, 'eth0');
    return { site, fortigate, client };
  });

  await configureLinux(bench, webInet, INTERNET.web, '203.0.113.254', '127.0.0.53');
  await configureLinux(bench, visitor, INTERNET.visitor, '203.0.113.254', '127.0.0.53');
  await configureLinux(bench, auditor, AUDITOR.address, '203.0.113.254', '127.0.0.53');
  await publishWebSite(bench, webInet, 'Internet - site de demonstration');

  await configureHeadquarters(bench, hq);
  for (const { site, fortigate } of agencies) await configureAgency(bench, fortigate, site);

  await configureWindows(bench, dc1, HQ.dc1, HQ.lanGateway, '127.0.0.1');
  await configureDomainController(bench, dc1, {
    oracle: HQ.oracle, www: HQ.web, mail: HQ.mail,
  });
  await configureLinux(bench, oracle, HQ.oracle, HQ.lanGateway, HQ.dc1);
  await configureLinux(bench, workstation, HQ.workstation, HQ.lanGateway, HQ.dc1);
  await configureLinux(bench, siem, HQ.siem, HQ.lanGateway, HQ.dc1);
  await configureSiem(bench, siem);
  await configureLinux(bench, web, HQ.web, HQ.dmzGateway, HQ.dc1);
  await publishWebSite(bench, web, `Meridian Industries - ${INTERNAL_DOMAIN}`);
  await configureLinux(bench, guest, GUEST.client, GUEST.gateway, HQ.dc1);
  await configureWindows(bench, mail, HQ.mail, HQ.dmzGateway, HQ.dc1);
  await joinDomainAndInstallExchange(bench, mail);
  for (const { site, client } of agencies) {
    await configureLinux(bench, client, site.lanGateway.replace(/\.1$/, '.50'), site.lanGateway, HQ.dc1);
  }

  await configureAuditWorkstation(bench, auditor);

  return { bench, devices };
}

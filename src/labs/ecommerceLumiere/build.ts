import { loadDevicePlatform } from '@/network';
import type { Equipment } from '@/network';
import { useNetworkStore } from '@/store/networkStore';
import { LabWorkbench } from '../LabWorkbench';
import { configureCiscoSwitch, configureDrRouter, configureFortiGateAgency, configureFortiGateDr, configureFortiGateHq, configureHqRouter, configureHuaweiSwitch, configureIsp } from './network';
import { configureLinux, configureWindows, forwardSyslog } from './hosts';
import { configureDomainControllers, configureLogServer, configurePublicDns, publishWebSite } from './services';
import { configureBackupServer, createOracleOsUser, declareBackupShare, giveHomeToOracle, loadShopSchema, shipScripts } from './oracle';
import { AGENCIES, DR, HQ, INTERNET, SYSLOG_PORT } from './plan';

export const BACKUP_EXPORT = '/srv/backup/rman';
export const BACKUP_MOUNT = '/backup';

export interface LumiereLab {
  readonly bench: LabWorkbench;
  readonly devices: ReadonlyMap<string, Equipment>;
}

const CANVAS_COMPRESSION = 0.78;
const CANVAS_TOP_MARGIN = 50;

export async function buildLumiere(): Promise<LumiereLab> {
  await loadDevicePlatform('firewall-fortinet');
  useNetworkStore.getState().clearAll();
  const bench = new LabWorkbench();
  const devices = new Map<string, Equipment>();
  const place = (type: Parameters<LabWorkbench['place']>[0], name: string, x: number, y: number): Equipment => {
    const device = bench.place(type, name, Math.round(40 + (x - 40) * CANVAS_COMPRESSION), y + CANVAS_TOP_MARGIN);
    devices.set(name, device);
    return device;
  };

  const swInet = place('switch-generic', 'SW-INTERNET', 900, 40);
  const risp = place('router-cisco', 'R-ISP', 1100, 40);
  const swExt = place('switch-generic', 'SW-CLIENTS', 1300, 40);
  const customer = place('linux-pc', 'PC-CLIENT', 1450, 20);
  const payment = place('linux-server', 'PAY-EXT', 1450, 100);
  const dnsPub = place('linux-server', 'DNS-PUB', 900, 140);

  const fgtHq = place('firewall-fortinet', 'FGT-HQ', 520, 200);
  const rHq = place('router-cisco', 'R-HQ', 360, 340);
  const swSrv = place('switch-cisco', 'SW-HQ-SRV', 160, 460);
  const swUsr = place('switch-cisco', 'SW-HQ-USR', 360, 460);
  const swDb = place('switch-cisco', 'SW-HQ-DB', 560, 460);
  const swDmz = place('switch-generic', 'SW-HQ-DMZ', 760, 340);
  const dc1 = place('windows-server', 'DC1', 100, 580);
  const log = place('linux-server', 'LOG-HQ', 240, 580);
  const pcHq = place('linux-pc', 'PC-HQ', 360, 580);
  const oraPrd = place('linux-server', 'ORA-PRD', 520, 580);
  const bkpHq = place('linux-server', 'BKP-HQ', 660, 580);
  const web1 = place('linux-server', 'WEB-1', 740, 460);
  const web2 = place('linux-server', 'WEB-2', 860, 460);
  const app1 = place('linux-server', 'APP-1', 980, 460);

  const fgtDr = place('firewall-fortinet', 'FGT-DR', 1000, 200);
  const rDr = place('router-huawei', 'R-DR', 1000, 340);
  const swDrSrv = place('switch-huawei', 'SW-DR-SRV', 1100, 460);
  const swDrDb = place('switch-huawei', 'SW-DR-DB', 1340, 460);
  const swDrDmz = place('switch-generic', 'SW-DR-DMZ', 1200, 340);
  const dc2 = place('windows-server', 'DC2', 1100, 580);
  const oraStb = place('linux-server', 'ORA-STB', 1300, 580);
  const bkpDr = place('linux-server', 'BKP-DR', 1420, 580);
  const webDr = place('linux-server', 'WEB-DR', 1240, 460);

  const agencies = AGENCIES.map((agency, index) => {
    const fgt = place('firewall-fortinet', `FGT-${agency.name}`, 40 + index * 200, 40);
    const switchType = index === 0 ? 'switch-cisco' : 'switch-huawei';
    const sw = place(switchType, `SW-${agency.name}`, 40 + index * 200, 120);
    const client = place('linux-pc', `PC-${agency.name}`, 40 + index * 200, 200);
    return { agency, fgt, sw, client };
  });

  bench.connect(risp, 'GigabitEthernet0/0', swInet, 'eth0');
  bench.connect(risp, 'GigabitEthernet0/1', swExt, 'eth0');
  bench.connect(customer, 'eth0', swExt, 'eth1');
  bench.connect(payment, 'eth0', swExt, 'eth2');
  bench.connect(dnsPub, 'eth0', swInet, 'eth5');
  bench.connect(fgtHq, 'wan1', swInet, 'eth1');
  bench.connect(fgtDr, 'wan1', swInet, 'eth2');

  bench.connect(fgtHq, 'port1', rHq, 'GigabitEthernet0/0');
  bench.connect(fgtHq, 'port2', swDmz, 'eth0');
  bench.connect(rHq, 'GigabitEthernet0/1', swSrv, 'FastEthernet0/1');
  bench.connect(swSrv, 'FastEthernet0/4', swUsr, 'FastEthernet0/1');
  bench.connect(swSrv, 'FastEthernet0/5', swDb, 'FastEthernet0/1');
  bench.connect(dc1, 'eth0', swSrv, 'FastEthernet0/2');
  bench.connect(log, 'eth0', swSrv, 'FastEthernet0/3');
  bench.connect(pcHq, 'eth0', swUsr, 'FastEthernet0/2');
  bench.connect(oraPrd, 'eth0', swDb, 'FastEthernet0/2');
  bench.connect(bkpHq, 'eth0', swDb, 'FastEthernet0/3');
  bench.connect(web1, 'eth0', swDmz, 'eth1');
  bench.connect(web2, 'eth0', swDmz, 'eth2');
  bench.connect(app1, 'eth0', swDmz, 'eth3');

  bench.connect(fgtDr, 'port1', rDr, 'GE0/0/0');
  bench.connect(fgtDr, 'port2', swDrDmz, 'eth0');
  bench.connect(rDr, 'GE0/0/1', swDrSrv, 'GigabitEthernet0/0/0');
  bench.connect(rDr, 'GE0/0/2', swDrDb, 'GigabitEthernet0/0/0');
  bench.connect(dc2, 'eth0', swDrSrv, 'GigabitEthernet0/0/1');
  bench.connect(oraStb, 'eth0', swDrDb, 'GigabitEthernet0/0/1');
  bench.connect(bkpDr, 'eth0', swDrDb, 'GigabitEthernet0/0/2');
  bench.connect(webDr, 'eth0', swDrDmz, 'eth1');

  agencies.forEach(({ agency, fgt, sw, client }, index) => {
    bench.connect(fgt, 'wan1', swInet, `eth${3 + index}`);
    bench.connect(fgt, 'port1', sw, index === 0 ? 'FastEthernet0/1' : 'GigabitEthernet0/0/0');
    bench.connect(client, 'eth0', sw, index === 0 ? 'FastEthernet0/2' : 'GigabitEthernet0/0/1');
    void agency;
  });

  await configureIsp(bench, risp);
  await configureFortiGateHq(bench, fgtHq, HQ.servers.log);
  await configureFortiGateDr(bench, fgtDr, HQ.servers.log);
  for (const { agency, fgt } of agencies) await configureFortiGateAgency(bench, fgt, agency, HQ.servers.log);
  await configureHqRouter(bench, rHq, HQ.servers.dc1, HQ.servers.log);
  await configureDrRouter(bench, rDr, HQ.servers.log);
  const hqVlans = [[10, 'SERVEURS'], [20, 'UTILISATEURS'], [30, 'BASES']] as const;
  await configureCiscoSwitch(bench, swSrv, { hostname: 'SW-HQ-SRV', vlans: hqVlans, access: [['FastEthernet0/2', 10], ['FastEthernet0/3', 10]], trunks: ['FastEthernet0/1', 'FastEthernet0/4', 'FastEthernet0/5'] });
  await configureCiscoSwitch(bench, swUsr, { hostname: 'SW-HQ-USR', vlans: hqVlans, access: [['FastEthernet0/2', 20]], trunks: ['FastEthernet0/1'] });
  await configureCiscoSwitch(bench, swDb, { hostname: 'SW-HQ-DB', vlans: hqVlans, access: [['FastEthernet0/2', 30], ['FastEthernet0/3', 30]], trunks: ['FastEthernet0/1'] });
  await configureHuaweiSwitch(bench, swDrSrv, 'SW-DR-SRV', 10, ['GigabitEthernet0/0/0', 'GigabitEthernet0/0/1']);
  await configureHuaweiSwitch(bench, swDrDb, 'SW-DR-DB', 30, ['GigabitEthernet0/0/0', 'GigabitEthernet0/0/1', 'GigabitEthernet0/0/2']);
  await configureCiscoSwitch(bench, agencies[0].sw, { hostname: 'SW-AG1', vlans: [[10, 'MAGASIN']], access: [['FastEthernet0/1', 10], ['FastEthernet0/2', 10]], trunks: [] });
  await configureHuaweiSwitch(bench, agencies[1].sw, 'SW-AG2', 10, ['GigabitEthernet0/0/0', 'GigabitEthernet0/0/1']);

  const dnsInternal = [HQ.servers.dc1];
  await configureLinux(bench, dnsPub, INTERNET.publicDns, 24, INTERNET.gateway, ['127.0.0.53'], 'dns-pub');
  await configureLinux(bench, customer, INTERNET.customer, 24, INTERNET.externalGateway, [INTERNET.publicDns], 'pc-client');
  await configureLinux(bench, payment, INTERNET.payment, 24, INTERNET.externalGateway, [INTERNET.publicDns], 'pay-ext');
  await configureWindows(bench, dc1, HQ.servers.dc1, 24, HQ.servers.gateway, ['127.0.0.1'], 'DC1');
  await configureLinux(bench, log, HQ.servers.log, 24, HQ.servers.gateway, dnsInternal, 'log-hq');
  await configureLinux(bench, oraPrd, HQ.db.oracle, 24, HQ.db.gateway, dnsInternal, 'ora-prd');
  await configureLinux(bench, bkpHq, HQ.db.backup, 24, HQ.db.gateway, dnsInternal, 'bkp-hq');
  await configureLinux(bench, web1, HQ.dmz.web1, 24, HQ.dmz.gateway, dnsInternal, 'web-1');
  await configureLinux(bench, web2, HQ.dmz.web2, 24, HQ.dmz.gateway, dnsInternal, 'web-2');
  await configureLinux(bench, app1, HQ.dmz.app, 24, HQ.dmz.gateway, dnsInternal, 'app-1');
  await configureWindows(bench, dc2, DR.servers.dc2, 24, DR.servers.gateway, [DR.servers.dc2, HQ.servers.dc1], 'DC2');
  await configureLinux(bench, oraStb, DR.db.standby, 24, DR.db.gateway, [DR.servers.dc2, HQ.servers.dc1], 'ora-stb');
  await configureLinux(bench, bkpDr, DR.db.backup, 24, DR.db.gateway, [DR.servers.dc2, HQ.servers.dc1], 'bkp-dr');
  await configureLinux(bench, webDr, DR.dmz.web, 24, DR.dmz.gateway, [DR.servers.dc2, HQ.servers.dc1], 'web-dr');
  for (const { agency, client } of agencies) {
    await configureLinux(bench, client, agency.client, 24, agency.gateway, dnsInternal, `pc-${agency.name.toLowerCase()}`);
  }
  await configureDomainControllers(bench, dc1, dc2);
  await configurePublicDns(bench, dnsPub);
  await configureLogServer(bench, log);
  for (const host of [oraPrd, oraStb, bkpHq, bkpDr, web1, web2, app1, webDr]) await forwardSyslog(bench, host, HQ.servers.log, SYSLOG_PORT);
  await publishWebSite(bench, web1, 'Lumiere Boutique - frontal web 1');
  await publishWebSite(bench, web2, 'Lumiere Boutique - frontal web 2');
  await publishWebSite(bench, webDr, 'Lumiere Boutique - site de reprise');
  await publishWebSite(bench, payment, 'Passerelle de paiement (simulee)');
  await bench.writeFile(pcHq, '/etc/netplan/01-lab.yaml', ['network:', '  version: 2', '  ethernets:', '    eth0:', '      dhcp4: true'].join('\n'), '600');
  await bench.shell(pcHq, 'sudo netplan apply', 'sudo ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf');
  await createOracleOsUser(bench, oraPrd);
  await createOracleOsUser(bench, oraStb);
  await createOracleOsUser(bench, bkpHq);
  await createOracleOsUser(bench, bkpDr);
  await configureBackupServer(bench, bkpHq, BACKUP_EXPORT, [`${HQ.db.network}/24(rw,sync,no_root_squash)`, `${DR.db.network}/24(ro,sync,no_root_squash)`]);
  await configureBackupServer(bench, bkpDr, BACKUP_EXPORT, [`${DR.db.network}/24(rw,sync,no_root_squash)`]);
  await shipScripts(bench, oraPrd);
  await shipScripts(bench, oraStb);
  await loadShopSchema(bench, oraPrd);
  await giveHomeToOracle(bench, oraPrd);
  await giveHomeToOracle(bench, oraStb);
  await declareBackupShare(bench, oraPrd, HQ.db.backup, BACKUP_EXPORT, BACKUP_MOUNT);
  await declareBackupShare(bench, oraStb, DR.db.backup, BACKUP_EXPORT, BACKUP_MOUNT);
  return { bench, devices };
}

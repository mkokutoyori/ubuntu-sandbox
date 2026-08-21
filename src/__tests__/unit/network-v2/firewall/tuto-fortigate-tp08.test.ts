import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const srvDmz = new LinuxServer('linux-server', 'SRV-DMZ', 200, 0);
  const pcWan = new LinuxServer('linux-server', 'PC-WAN', 0, -200);

  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srvDmz.getPort('eth0')!);
  new Cable('wan').connect(fgt.getPort('port1')!, pcWan.getPort('eth0')!);

  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(srvDmz, [
    'ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1',
  ]);
  await taper(pcWan, [
    'ip addr add 192.168.100.50/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.100.99',
  ]);
  await srvDmz.executeCommand('systemctl start nginx');

  await taper(fgt, [
    'config system interface',
    'edit port1', 'set mode static',
    'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
    'config firewall address',
    'edit "NET-LAN"', 'set subnet 192.168.10.0 255.255.255.0', 'next',
    'edit "HOST-SRV-DMZ"', 'set subnet 192.168.20.10 255.255.255.255', 'next',
    'end',
    'config firewall policy', 'edit 1',
    'set name "LAN-vers-Internet"',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "NET-LAN"', 'set dstaddr "all"',
    'set service "ALL"', 'set schedule "always"', 'set action accept',
    'set nat enable', 'set logtraffic all', 'next', 'end',
  ]);
  return { fgt, pcLan, srvDmz, pcWan };
}

async function vip(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config firewall vip', 'edit "VIP-Serveur-Web"',
    'set extip 192.168.100.200',
    'set extintf "port1"',
    'set mappedip "192.168.20.10"',
    'set portforward enable',
    'set protocol tcp',
    'set extport 80',
    'set mappedport 80',
    'set comment "Publication du serveur web DMZ"',
    'next', 'end',
  ]);
}

async function politiqueFausse(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config firewall policy', 'edit 3',
    'set name "Publication-Web-FAUSSE"',
    'set srcintf "port1"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "HOST-SRV-DMZ"',
    'set service "HTTP"', 'set schedule "always"',
    'set action accept', 'set logtraffic all',
    'next', 'end',
  ]);
}

describe('TP 8 — publier un serveur et observer le NAT', () => {
  it('etape 1 : une session sortante porte `act=snat` et la traduction', async () => {
    const { fgt, pcLan } = await laboratoire();
    await pingOnSimulatedClock(pcLan, 'ping -c 2 192.168.100.50');

    await fgt.executeCommand('diagnose sys session filter dst 192.168.100.50');
    const vue = await fgt.executeCommand('diagnose sys session list');
    expect(vue).toContain('act=snat');
    expect(vue).toMatch(/hook=post dir=org act=snat 192\.168\.10\.10/);
    expect(vue).toContain('192.168.100.99');
  });

  it('etape 2 : le correspondant voit l\'adresse du pare-feu, pas celle du PC',
    async () => {
      const { pcLan, pcWan } = await laboratoire();
      await pcWan.executeCommand('systemctl start nginx');
      expect(await pcLan.executeCommand('curl -sS http://192.168.100.50/'))
        .toContain('Welcome to nginx!');

      const journal = await pcWan.executeCommand('cat /var/log/nginx/access.log');
      expect(journal).toContain('192.168.100.99');
      expect(journal).not.toContain('192.168.10.10');
    });

  it('etape 3 : le VIP se declare et se relit', async () => {
    const { fgt } = await laboratoire();
    propre(await vip(fgt));
    const conf = await fgt.executeCommand('show firewall vip VIP-Serveur-Web');
    expect(conf).toContain('set extip 192.168.100.200');
    expect(conf).toContain('set mappedip "192.168.20.10"');
    expect(conf).toContain('set portforward enable');
    expect(conf).toContain('set extport 80');
  });

  it('etape 4 : la politique qui nomme l\'adresse INTERNE ne marche pas', async () => {
    const { fgt, pcWan } = await laboratoire();
    await vip(fgt);
    propre(await politiqueFausse(fgt));

    expect(await pcWan.executeCommand('curl -sS http://192.168.100.200/'))
      .not.toContain('Welcome to nginx!');
  });

  it('etape 5 : nommer le VIP en destination PUBLIE le serveur', async () => {
    const { fgt, pcWan } = await laboratoire();
    await vip(fgt);
    await politiqueFausse(fgt);
    propre(await taper(fgt, [
      'config firewall policy', 'edit 3',
      'set name "Publication-Web"',
      'set dstaddr "VIP-Serveur-Web"',
      'set nat disable',
      'next', 'end',
    ]));

    expect(await pcWan.executeCommand('curl -sS http://192.168.100.200/'))
      .toContain('Welcome to nginx!');
  });

  it('etape 6 : la session entrante porte `act=dnat` et la traduction', async () => {
    const { fgt, pcWan } = await laboratoire();
    await vip(fgt);
    await politiqueFausse(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 3',
      'set dstaddr "VIP-Serveur-Web"', 'set nat disable', 'next', 'end',
    ]);
    await pcWan.executeCommand('curl -sS http://192.168.100.200/');

    await fgt.executeCommand('diagnose sys session filter dst 192.168.100.200');
    const vue = await fgt.executeCommand('diagnose sys session list');
    expect(vue).toContain('act=dnat');
    expect(vue).toMatch(/hook=pre dir=org act=dnat/);
    expect(vue).toContain('192.168.20.10:80');
  });

  it('etape 7 : `nat disable` PRESERVE l\'adresse du visiteur', async () => {
    const { fgt, srvDmz, pcWan } = await laboratoire();
    await vip(fgt);
    await politiqueFausse(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 3',
      'set dstaddr "VIP-Serveur-Web"', 'set nat disable', 'next', 'end',
    ]);
    await pcWan.executeCommand('curl -sS http://192.168.100.200/');

    const journal = await srvDmz.executeCommand('cat /var/log/nginx/access.log');
    expect(journal).toContain('192.168.100.50');
    expect(journal).not.toContain('192.168.20.1 ');
  });

  it('etape 7 : `nat enable` ECRASE l\'adresse du visiteur', async () => {
    const { fgt, srvDmz, pcWan } = await laboratoire();
    await vip(fgt);
    await politiqueFausse(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 3',
      'set dstaddr "VIP-Serveur-Web"', 'set nat enable', 'next', 'end',
    ]);
    await pcWan.executeCommand('curl -sS http://192.168.100.200/');

    const journal = await srvDmz.executeCommand('cat /var/log/nginx/access.log');
    expect(journal).toContain('192.168.20.1');
    expect(journal).not.toContain('192.168.100.50');
  });

  it('etape 8 : restreindre `srcaddr` REFUSE les autres sources', async () => {
    const { fgt, pcWan } = await laboratoire();
    await vip(fgt);
    await taper(fgt, [
      'config firewall address', 'edit "NET-Autorise-Externe"',
      'set subnet 10.99.0.0 255.255.0.0', 'next', 'end',
      'config firewall policy', 'edit 3',
      'set name "Publication-Web"',
      'set srcintf "port1"', 'set dstintf "port3"',
      'set srcaddr "NET-Autorise-Externe"', 'set dstaddr "VIP-Serveur-Web"',
      'set service "HTTP"', 'set schedule "always"',
      'set action accept', 'set nat disable', 'next', 'end',
    ]);

    expect(await pcWan.executeCommand('curl -sS http://192.168.100.200/'))
      .not.toContain('Welcome to nginx!');
  });

  it('etape 9 : `show firewall vip` et `diagnose firewall vip list` repondent',
    async () => {
      const { fgt } = await laboratoire();
      await vip(fgt);

      expect(await fgt.executeCommand('show firewall vip'))
        .toContain('edit "VIP-Serveur-Web"');
      const liste = await fgt.executeCommand('diagnose firewall vip list');
      expect(liste).not.toMatch(/Unknown action/i);
      expect(liste).toContain('192.168.100.200');
      expect(liste).toContain('192.168.20.10');
    });

  it('etape 10 : supprimer la politique laisse le VIP en place', async () => {
    const { fgt } = await laboratoire();
    await vip(fgt);
    await politiqueFausse(fgt);
    propre(await taper(fgt, ['config firewall policy', 'delete 3', 'end']));

    expect(await fgt.executeCommand('show firewall policy'))
      .not.toContain('Publication-Web-FAUSSE');
    expect(await fgt.executeCommand('show firewall vip'))
      .toContain('edit "VIP-Serveur-Web"');
  });
});

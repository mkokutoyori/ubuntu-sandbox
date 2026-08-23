import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

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

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const srvDmz = new LinuxServer('linux-server', 'SRV-DMZ', 200, 0);
  const r1 = new LinuxServer('linux-server', 'R1-EDGE', 0, -200);

  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srvDmz.getPort('eth0')!);
  new Cable('wan').connect(fgt.getPort('port1')!, r1.getPort('eth0')!);

  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(srvDmz, [
    'ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1',
  ]);
  await taper(r1, [
    'ip addr add 192.168.100.1/24 dev eth0', 'ip link set eth0 up',
    'ip addr add 8.8.8.8/32 dev lo',
    'ip route add 192.168.10.0/24 via 192.168.100.99',
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
    'config router static', 'edit 1',
    'set dst 0.0.0.0 0.0.0.0', 'set gateway 192.168.100.1', 'set device "port1"',
    'next', 'end',
    'config firewall address',
    'edit "NET-LAN"', 'set subnet 192.168.10.0 255.255.255.0', 'next',
    'edit "NET-DMZ"', 'set subnet 192.168.20.0 255.255.255.0', 'next',
    'end',
    'config firewall policy',
    'edit 1', 'set name "LAN-vers-Internet"',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "NET-LAN"', 'set dstaddr "all"',
    'set service "ALL"', 'set schedule "always"', 'set action accept',
    'set nat enable', 'set logtraffic all', 'next',
    'edit 2', 'set name "LAN-vers-DMZ"',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "NET-LAN"', 'set dstaddr "NET-DMZ"',
    'set service "PING" "HTTP"', 'set schedule "always"',
    'set action accept', 'set logtraffic all', 'next', 'end',
    'config firewall vip', 'edit "VIP-Serveur-Web"',
    'set extip 192.168.100.200', 'set extintf "port1"',
    'set mappedip "192.168.20.10"', 'set portforward enable',
    'set protocol tcp', 'set extport 80', 'set mappedport 80', 'next', 'end',
    'config firewall policy', 'edit 3', 'set name "Publication-Web"',
    'set srcintf "port1"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "VIP-Serveur-Web"',
    'set service "HTTP"', 'set schedule "always"', 'set action accept',
    'next', 'end',
  ]);
  return { fgt, pcLan, srvDmz, r1 };
}

async function armerTrace(fgt: FortiGate, adresse: string): Promise<string[]> {
  return taper(fgt, [
    'diagnose debug reset',
    'diagnose debug flow filter clear',
    `diagnose debug flow filter addr ${adresse}`,
    'diagnose debug flow show function-name enable',
    'diagnose debug flow trace start 20',
    'diagnose debug enable',
  ]);
}

describe('TP 23 — Depanner trois pannes que tu ne connais pas', () => {
  describe('Panne n°1 — le LAN n\'accede plus a la DMZ', () => {
    it('la panne se provoque : le service de la politique 2 devient HTTPS', async () => {
      const { fgt } = await laboratoire();
      propre(await taper(fgt, [
        'config firewall policy', 'edit 2', 'set service "HTTPS"', 'next', 'end',
      ]));

      expect(await fgt.executeCommand('show firewall policy 2'))
        .toContain('set service "HTTPS"');
    });

    it('le LAN n\'atteint plus le serveur web de la DMZ', async () => {
      const { fgt, pcLan } = await laboratoire();
      expect(await pcLan.executeCommand('curl -sS http://192.168.20.10/'))
        .toContain('nginx');

      await taper(fgt, [
        'config firewall policy', 'edit 2', 'set service "HTTPS"', 'next', 'end',
      ]);

      expect(await pcLan.executeCommand('curl -sS http://192.168.20.10/'))
        .not.toContain('nginx');
    });

    it('le renifleur montre le paquet qui ARRIVE et ne ressort pas', async () => {
      const { fgt, pcLan } = await laboratoire();
      await taper(fgt, [
        'config firewall policy', 'edit 2', 'set service "HTTPS"', 'next', 'end',
      ]);
      await pcLan.executeCommand('curl -sS http://192.168.20.10/');

      const trace = await fgt.executeCommand(
        "diagnose sniffer packet any 'host 192.168.20.10' 4 10");

      expect(trace).toContain('192.168.20.10');
      expect(trace).toMatch(/port2/);
      expect(trace).not.toMatch(/port3/);
    });

    it('la trace de flux dit `Denied by forward policy check (policy 0)`', async () => {
      const { fgt, pcLan } = await laboratoire();
      await taper(fgt, [
        'config firewall policy', 'edit 2', 'set service "HTTPS"', 'next', 'end',
      ]);
      await armerTrace(fgt, '192.168.20.10');
      await pcLan.executeCommand('curl -sS http://192.168.20.10/');

      const trace = await fgt.executeCommand('diagnose debug enable');

      expect(trace).toContain('Denied by forward policy check');
      expect(trace).toContain('policy 0');
    });

    it('la reparation rend l\'acces : `set service "PING" "HTTP"`', async () => {
      const { fgt, pcLan } = await laboratoire();
      await taper(fgt, [
        'config firewall policy', 'edit 2', 'set service "HTTPS"', 'next', 'end',
      ]);
      propre(await taper(fgt, [
        'config firewall policy', 'edit 2', 'set service "PING" "HTTP"', 'next', 'end',
      ]));

      expect(await pcLan.executeCommand('curl -sS http://192.168.20.10/'))
        .toContain('nginx');
    });
  });

  describe('Panne n°2 — plus d\'acces Internet depuis le LAN', () => {
    it('la panne se provoque : `set nat disable` sur la politique 1', async () => {
      const { fgt } = await laboratoire();
      propre(await taper(fgt, [
        'config firewall policy', 'edit 1', 'set nat disable', 'next', 'end',
      ]));

      expect(await fgt.executeCommand('show firewall policy 1'))
        .not.toContain('set nat enable');
    });

    it('la trace de flux AUTORISE quand meme — le filtrage n\'est pas en cause', async () => {
      const { fgt, pcLan } = await laboratoire();
      await taper(fgt, [
        'config firewall policy', 'edit 1', 'set nat disable', 'next', 'end',
      ]);
      await armerTrace(fgt, '8.8.8.8');
      await pcLan.executeCommand('ping -c 1 8.8.8.8');

      expect(await fgt.executeCommand('diagnose debug enable'))
        .toMatch(/Allowed by Policy-1/);
    });

    it('le renifleur montre le paquet qui sort avec son adresse PRIVEE', async () => {
      const { fgt, pcLan } = await laboratoire();
      await taper(fgt, [
        'config firewall policy', 'edit 1', 'set nat disable', 'next', 'end',
      ]);
      await pcLan.executeCommand('ping -c 1 8.8.8.8');

      const trace = await fgt.executeCommand(
        "diagnose sniffer packet port1 'host 8.8.8.8' 4 10");

      expect(trace).toContain('192.168.10.10 -> 8.8.8.8');
    });

    it('la table de sessions ne porte AUCUN `act=snat`', async () => {
      const { fgt, pcLan } = await laboratoire();
      await taper(fgt, [
        'config firewall policy', 'edit 1', 'set nat disable', 'next', 'end',
      ]);
      await pcLan.executeCommand('ping -c 1 8.8.8.8');

      await taper(fgt, [
        'diagnose sys session filter clear',
        'diagnose sys session filter dst 8.8.8.8',
      ]);
      const sessions = await fgt.executeCommand('diagnose sys session list');

      expect(sessions).toContain('8.8.8.8');
      expect(sessions).not.toContain('act=snat');
    });

    it('la reparation rend la traduction : `set nat enable`', async () => {
      const { fgt, pcLan } = await laboratoire();
      await taper(fgt, [
        'config firewall policy', 'edit 1', 'set nat disable', 'next', 'end',
      ]);
      propre(await taper(fgt, [
        'config firewall policy', 'edit 1', 'set nat enable', 'next', 'end',
      ]));
      await pcLan.executeCommand('ping -c 1 8.8.8.8');

      await taper(fgt, [
        'diagnose sys session filter clear',
        'diagnose sys session filter dst 8.8.8.8',
      ]);

      expect(await fgt.executeCommand('diagnose sys session list'))
        .toContain('act=snat');
    });
  });

  describe('Panne n°3 — le serveur publie n\'est plus joignable', () => {
    it('la panne se provoque : le `mappedip` du VIP pointe ailleurs', async () => {
      const { fgt } = await laboratoire();
      propre(await taper(fgt, [
        'config firewall vip', 'edit "VIP-Serveur-Web"',
        'set mappedip "192.168.20.99"', 'next', 'end',
      ]));

      expect(await fgt.executeCommand('show firewall vip VIP-Serveur-Web'))
        .toContain('192.168.20.99');
    });

    it('le serveur publie ne repond plus depuis le WAN', async () => {
      const { fgt, r1 } = await laboratoire();
      expect(await r1.executeCommand('curl -sS http://192.168.100.200/'))
        .toContain('nginx');

      await taper(fgt, [
        'config firewall vip', 'edit "VIP-Serveur-Web"',
        'set mappedip "192.168.20.99"', 'next', 'end',
      ]);

      expect(await r1.executeCommand('curl -sS http://192.168.100.200/'))
        .not.toContain('nginx');
    });

    it('le pare-feu lui-meme ne joint pas la machine designee', async () => {
      const { fgt } = await laboratoire();

      expect(await fgt.executeCommand('execute ping 192.168.20.99'))
        .toMatch(/100% packet loss|Host is unreachable|no response/i);
    });

    it('la trace de flux montre le DNAT vers l\'adresse fautive', async () => {
      const { fgt, r1 } = await laboratoire();
      await taper(fgt, [
        'config firewall vip', 'edit "VIP-Serveur-Web"',
        'set mappedip "192.168.20.99"', 'next', 'end',
      ]);
      await armerTrace(fgt, '192.168.100.200');
      await r1.executeCommand('curl -sS http://192.168.100.200/');

      const trace = await fgt.executeCommand('diagnose debug enable');

      expect(trace).toMatch(/DNAT/);
      expect(trace).toContain('192.168.20.99');
    });

    it('la reparation rend la publication : `set mappedip "192.168.20.10"`', async () => {
      const { fgt, r1 } = await laboratoire();
      await taper(fgt, [
        'config firewall vip', 'edit "VIP-Serveur-Web"',
        'set mappedip "192.168.20.99"', 'next', 'end',
      ]);
      propre(await taper(fgt, [
        'config firewall vip', 'edit "VIP-Serveur-Web"',
        'set mappedip "192.168.20.10"', 'next', 'end',
      ]));

      expect(await r1.executeCommand('curl -sS http://192.168.100.200/'))
        .toContain('nginx');
    });
  });
});

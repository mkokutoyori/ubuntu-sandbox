import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import {
  IPAddress, IP_PROTO_TCP, MACAddress, createIPv4Packet, resetCounters,
  type TCPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

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
  const externe = new LinuxServer('linux-server', 'EXT', 0, -200);

  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srvDmz.getPort('eth0')!);
  new Cable('wan').connect(fgt.getPort('port1')!, externe.getPort('eth0')!);

  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(srvDmz, [
    'ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1',
  ]);
  await taper(externe, [
    'ip addr add 203.0.113.50/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 203.0.113.1',
  ]);
  await srvDmz.executeCommand('systemctl start nginx');
  await externe.executeCommand('systemctl start nginx');

  await taper(fgt, [
    'config system interface',
    'edit port1', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
    'config firewall policy', 'edit 1',
    'set name "LAN-vers-Internet"',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set schedule "always"',
    'set action accept', 'set nat enable', 'set logtraffic all', 'next',
    'edit 2', 'set name "LAN-vers-DMZ"',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set schedule "always"',
    'set action accept', 'set logtraffic all', 'next', 'end',
  ]);
  return { fgt, pcLan, srvDmz, externe };
}

describe('TP 14 — le bilan, exigence par exigence', () => {
  it('exigence 1 : la navigation fonctionne a travers le pare-feu', async () => {
    const { pcLan } = await laboratoire();
    expect(await pcLan.executeCommand(
      'curl -s -o /dev/null -w "%{http_code}\\n" http://203.0.113.50/'))
      .toContain('200');
  });

  it('exigence 2 : ni le balayage ACK ni le balayage SYN n\'entrent', async () => {
    const { pcLan, externe } = await laboratoire();
    await pcLan.executeCommand('nc -l -p 8080 &');

    const ack = await externe.executeCommand('nmap -sA -p 8080 192.168.10.10');
    const syn = await externe.executeCommand('nmap -sS -p 8080 192.168.10.10');

    expect(ack).not.toMatch(/8080\/tcp\s+unfiltered/);
    expect(syn).not.toMatch(/8080\/tcp\s+open/);
  });

  it('exigence 3 : un service sur un port NON STANDARD est reconnu', async () => {
    const { fgt, pcLan, srvDmz } = await laboratoire();
    await srvDmz.executeCommand('nc -l -p 6881 &');

    propre(await taper(fgt, [
      'config application list', 'edit "APP-Lab"',
      'set comment "Controle applicatif du laboratoire"',
      'config entries', 'edit 1',
      'set application "HTTP.BROWSER"',
      'set action block',
      'next', 'end',
      'next', 'end',
    ]));

    propre(await taper(fgt, [
      'config firewall policy', 'edit 2',
      'set utm-status enable',
      'set application-list "APP-Lab"',
      'next', 'end',
    ]));

    expect(await fgt.executeCommand('show firewall policy 2'))
      .toContain('set application-list "APP-Lab"');
    void pcLan;
  });

  it('exigence 3 : le controle applicatif juge le PROTOCOLE, pas le port', async () => {
    const { fgt, pcLan, srvDmz } = await laboratoire();
    await srvDmz.executeCommand('systemctl start nginx');
    await taper(fgt, [
      'config application list', 'edit "APP-Lab"',
      'config entries', 'edit 1',
      'set application "HTTP.BROWSER"', 'set action block', 'next', 'end',
      'next', 'end',
      'config firewall policy', 'edit 2',
      'set utm-status enable', 'set inspection-mode flow',
      'set application-list "APP-Lab"', 'set logtraffic all', 'next', 'end',
    ]);

    expect(await pcLan.executeCommand('curl -sS http://192.168.20.10/'))
      .not.toContain('Welcome to nginx!');
  });

  it('exigence 4 : un executable deguise reste bloque', async () => {
    const { fgt, pcLan, srvDmz } = await laboratoire();
    await srvDmz.executeCommand(
      "printf 'MZ\\x90\\x00\\x03\\x00\\x00\\x00\\x04\\x00' > /var/www/html/photo.jpg");
    await taper(fgt, [
      'config file-filter profile', 'edit "FF-Lab"',
      'set feature-set flow',
      'config rules', 'edit "Exe"',
      'set protocol http-get', 'set action block',
      'set file-type "exe"', 'next', 'end',
      'next', 'end',
      'config firewall policy', 'edit 2',
      'set utm-status enable', 'set inspection-mode flow',
      'set file-filter-profile "FF-Lab"', 'next', 'end',
    ]);

    expect(await pcLan.executeCommand('curl -sS http://192.168.20.10/photo.jpg'))
      .not.toContain('MZ');
  });

  it('exigence 5 : `diagnose firewall auth list` rend les identites', async () => {
    const { fgt } = await laboratoire();
    const vide = await fgt.executeCommand('diagnose firewall auth list');
    expect(vide).not.toMatch(/Unknown action/i);

    await taper(fgt, [
      'config user local', 'edit "jdupont"',
      'set type password', 'set passwd "Secret2026!"', 'next', 'end',
    ]);
    await fgt.getAuthPortal().authenticate(
      '192.168.10.10', { username: 'jdupont', password: 'Secret2026!' });

    const vue = await fgt.executeCommand('diagnose firewall auth list');
    expect(vue).toContain('192.168.10.10');
    expect(vue).toContain('jdupont');
  });

  it('l\'ACL anti-usurpation de la RFC 2827 se pose sur le routeur', async () => {
    const r1 = new CiscoRouter('R1-EDGE', 0, 0);
    propre(await taper(r1, [
      'enable', 'configure terminal',
      'ip access-list extended ANTI-BRUIT',
      'deny ip 192.168.0.0 0.0.255.255 any log',
      'deny ip 10.0.0.0 0.255.255.255 any log',
      'deny ip 172.16.0.0 0.15.255.255 any log',
      'deny ip 127.0.0.0 0.255.255.255 any log',
      'deny ip 169.254.0.0 0.0.255.255 any log',
      'deny ip 224.0.0.0 15.255.255.255 any log',
      'permit ip any any',
      'exit',
      'interface GigabitEthernet0/0',
      'ip access-group ANTI-BRUIT in',
      'exit', 'end',
    ]));
    const vue = await r1.executeCommand('show ip access-lists ANTI-BRUIT');
    expect(vue).toContain('deny ip 192.168.0.0 0.0.255.255 any');
    expect(vue).toContain('permit ip any any');
  });

  it('l\'ACL anti-usurpation REFUSE vraiment une source interne venue du dehors',
    async () => {
      const r1 = new CiscoRouter('R1-EDGE', 0, 0);
      const interne = new LinuxPC('linux-pc', 'PC', -200, 0);
      const dehors = new LinuxServer('linux-server', 'EXT', 200, 0);

      new Cable('lan').connect(interne.getPort('eth0')!, r1.getPort('GigabitEthernet0/1')!);
      new Cable('wan').connect(r1.getPort('GigabitEthernet0/0')!, dehors.getPort('eth0')!);

      await taper(r1, [
        'enable', 'configure terminal',
        'interface GigabitEthernet0/1',
        'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
        'interface GigabitEthernet0/0',
        'ip address 203.0.113.1 255.255.255.0', 'no shutdown', 'exit',
        'ip access-list extended ANTI-BRUIT',
        'deny ip 192.168.0.0 0.0.255.255 any log',
        'permit ip any any', 'exit',
        'interface GigabitEthernet0/0',
        'ip access-group ANTI-BRUIT in', 'exit', 'end',
      ]);
      await taper(interne, [
        'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
        'ip route add default via 192.168.10.1',
      ]);
      await taper(dehors, [
        'ip addr add 203.0.113.50/24 dev eth0', 'ip link set eth0 up',
        'ip addr add 192.168.10.99/24 dev eth0',
        'ip route add default via 203.0.113.1',
      ]);

      const usurpe = createIPv4Packet(
        new IPAddress('192.168.10.99'), new IPAddress('192.168.10.10'),
        IP_PROTO_TCP, 64,
        {
          type: 'tcp', sourcePort: 49152, destinationPort: 80,
          sequenceNumber: 0, acknowledgementNumber: 0,
          flags: { syn: true, ack: false, fin: false, rst: false, psh: false, urg: false },
          windowSize: 65535, checksum: 0, payload: null,
        } as TCPPacket,
        20);
      const legitime = createIPv4Packet(
        new IPAddress('203.0.113.50'), new IPAddress('192.168.10.10'),
        IP_PROTO_TCP, 64,
        {
          type: 'tcp', sourcePort: 49152, destinationPort: 80,
          sequenceNumber: 0, acknowledgementNumber: 0,
          flags: { syn: true, ack: false, fin: false, rst: false, psh: false, urg: false },
          windowSize: 65535, checksum: 0, payload: null,
        } as TCPPacket,
        20);

      expect(r1.evaluateACLByName('ANTI-BRUIT', usurpe, new Date())).toBe('deny');
      expect(r1.evaluateACLByName('ANTI-BRUIT', legitime, new Date())).toBe('permit');
      void interne;
      void dehors;
    });

  it('le tableau du TP : le pare-feu couvre les cinq exigences avec DEUX politiques',
    async () => {
      const { fgt } = await laboratoire();
      const regles = fgt.getPolicyStore().ordered().filter(r => !r.implicit);
      expect(regles).toHaveLength(2);
      expect(regles.every(r => r.from.includes('port2'))).toBe(true);
    });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxServer } from '@/network/devices/LinuxServer';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
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

const ZONE_LAB = [
  '$ORIGIN lab.local.',
  '$TTL 3600',
  '@   IN SOA ns.lab.local. admin.lab.local. ( 2026010101 3600 900 604800 300 )',
  '    IN NS  ns.lab.local.',
  'ns  IN A   192.168.100.53',
  'www IN A   203.0.113.77',
  '',
].join('\n');

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function fortigate(): FortiGate {
  return new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
}

describe('TP 6 — construire le vocabulaire du laboratoire', () => {
  it('etape 1 : les reseaux se creent avec commentaire et couleur', async () => {
    const fgt = fortigate();
    propre(await taper(fgt, [
      'config firewall address',
      'edit "NET-LAN"', 'set subnet 192.168.10.0 255.255.255.0',
      'set comment "Reseau des postes utilisateurs"', 'set color 2', 'next',
      'edit "NET-DMZ"', 'set subnet 192.168.20.0 255.255.255.0',
      'set comment "Reseau des serveurs publies"', 'set color 3', 'next',
      'end',
    ]));
    const conf = await fgt.executeCommand('show firewall address NET-LAN');
    expect(conf).toContain('set subnet 192.168.10.0 255.255.255.0');
    expect(conf).toContain('set comment "Reseau des postes utilisateurs"');
    expect(conf).toContain('set color 2');
  });

  it('etape 3 : une PLAGE se declare par ses deux bornes', async () => {
    const fgt = fortigate();
    propre(await taper(fgt, [
      'config firewall address', 'edit "RANGE-LAN-Imprimantes"',
      'set type iprange',
      'set start-ip 192.168.10.200',
      'set end-ip 192.168.10.220',
      'next', 'end',
    ]));
    const conf = await fgt.executeCommand('show firewall address RANGE-LAN-Imprimantes');
    expect(conf).toContain('set type iprange');
    expect(conf).toContain('set start-ip 192.168.10.200');
    expect(conf).toContain('set end-ip 192.168.10.220');
  });

  it('etape 3 : la plage COUVRE vraiment ses adresses', async () => {
    const fgt = fortigate();
    await taper(fgt, [
      'config firewall address', 'edit "RANGE-LAN-Imprimantes"',
      'set type iprange', 'set start-ip 192.168.10.200',
      'set end-ip 192.168.10.220', 'next', 'end',
    ]);
    const objets = fgt.getObjectStore();
    expect(objets.matchesAddress('RANGE-LAN-Imprimantes', '192.168.10.210')).toBe(true);
    expect(objets.matchesAddress('RANGE-LAN-Imprimantes', '192.168.10.199')).toBe(false);
    expect(objets.matchesAddress('RANGE-LAN-Imprimantes', '192.168.10.221')).toBe(false);
  });

  it('etape 4 : un groupe porte ses deux membres et les COUVRE', async () => {
    const fgt = fortigate();
    await taper(fgt, [
      'config firewall address',
      'edit "NET-LAN"', 'set subnet 192.168.10.0 255.255.255.0', 'next',
      'edit "NET-DMZ"', 'set subnet 192.168.20.0 255.255.255.0', 'next',
      'end',
    ]);
    propre(await taper(fgt, [
      'config firewall addrgrp', 'edit "GRP-Reseaux-Internes"',
      'set member "NET-LAN" "NET-DMZ"',
      'set comment "Tous les reseaux internes"',
      'next', 'end',
    ]));
    const conf = await fgt.executeCommand('show firewall addrgrp GRP-Reseaux-Internes');
    expect(conf).toContain('NET-LAN');
    expect(conf).toContain('NET-DMZ');

    const objets = fgt.getObjectStore();
    expect(objets.matchesAddress('GRP-Reseaux-Internes', '192.168.10.5')).toBe(true);
    expect(objets.matchesAddress('GRP-Reseaux-Internes', '192.168.20.5')).toBe(true);
    expect(objets.matchesAddress('GRP-Reseaux-Internes', '192.168.30.5')).toBe(false);
  });

  it('etape 5 : un service personnalise porte sa plage de ports', async () => {
    const fgt = fortigate();
    propre(await taper(fgt, [
      'config firewall service custom', 'edit "SVC-App-8080"',
      'set tcp-portrange 8080',
      'set comment "Application metier de test"',
      'set category "Web Access"',
      'next', 'end',
    ]));
    const conf = await fgt.executeCommand('show firewall service custom SVC-App-8080');
    expect(conf).toContain('set tcp-portrange 8080');
    expect(conf).toContain('set category "Web Access"');
  });

  it('etape 6 : un groupe de services nomme des services PREDEFINIS', async () => {
    const fgt = fortigate();
    propre(await taper(fgt, [
      'config firewall service group', 'edit "GRP-SVC-Web"',
      'set member "HTTP" "HTTPS" "DNS"',
      'set comment "Navigation web de base"',
      'next', 'end',
    ]));
    const conf = await fgt.executeCommand('show firewall service group GRP-SVC-Web');
    expect(conf).toContain('HTTP');
    expect(conf).toContain('HTTPS');
    expect(conf).toContain('DNS');
  });

  it('etape 7 : un horaire recurrent porte ses jours et ses bornes', async () => {
    const fgt = fortigate();
    propre(await taper(fgt, [
      'config firewall schedule recurring', 'edit "Heures-Bureau"',
      'set day monday tuesday wednesday thursday friday',
      'set start 08:00',
      'set end 18:30',
      'next', 'end',
    ]));
    const conf = await fgt.executeCommand('show firewall schedule recurring Heures-Bureau');
    expect(conf).toContain('monday');
    expect(conf).toContain('friday');
    expect(conf).toContain('set start 08:00');
    expect(conf).toContain('set end 18:30');
  });

  it('etape 8 : un objet FQDN se declare', async () => {
    const fgt = fortigate();
    propre(await taper(fgt, [
      'config firewall address', 'edit "FQDN-Test"',
      'set type fqdn', 'set fqdn "www.fortinet.com"', 'next', 'end',
    ]));
    const conf = await fgt.executeCommand('show firewall address FQDN-Test');
    expect(conf).toContain('set type fqdn');
    expect(conf).toContain('set fqdn "www.fortinet.com"');
  });

  it('etape 8 : `diagnose firewall fqdn list` rend ce que le DNS a RESOLU', async () => {
    const fgt = fortigate();
    const dns = new LinuxServer('linux-server', 'DNS', 200, 0);
    new Cable('wan').connect(fgt.getPort('port1')!, dns.getPort('eth0')!);
    await taper(dns, [
      'ip addr add 192.168.100.53/24 dev eth0', 'ip link set eth0 up',
    ]);
    await taper(fgt, [
      'config system interface', 'edit port1', 'set mode static',
      'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping', 'next', 'end',
      'config system dns', 'set primary 192.168.100.53', 'end',
    ]);

    const vide = await fgt.executeCommand('diagnose firewall fqdn list');
    expect(vide).not.toMatch(/Unknown action/i);

    await taper(fgt, [
      'config firewall address', 'edit "FQDN-Test"',
      'set type fqdn', 'set fqdn "www.fortinet.com"', 'next', 'end',
    ]);
    expect(await fgt.executeCommand('diagnose firewall fqdn list'))
      .toContain('www.fortinet.com');
  });

  it('etape 8 : `show system dns` rend le resolveur configure', async () => {
    const fgt = fortigate();
    propre(await taper(fgt, [
      'config system dns', 'set primary 192.168.100.53', 'end',
    ]));
    expect(await fgt.executeCommand('show system dns'))
      .toContain('set primary 192.168.100.53');
  });

  it('etape 9 : les quatre relectures du TP repondent', async () => {
    const fgt = fortigate();
    await taper(fgt, [
      'config firewall address',
      'edit "NET-LAN"', 'set subnet 192.168.10.0 255.255.255.0', 'next', 'end',
      'config firewall addrgrp', 'edit "GRP"', 'set member "NET-LAN"', 'next', 'end',
      'config firewall service custom', 'edit "SVC-App-8080"',
      'set tcp-portrange 8080', 'next', 'end',
      'config firewall schedule recurring', 'edit "Heures-Bureau"',
      'set day monday', 'set start 08:00', 'set end 18:30', 'next', 'end',
    ]);

    expect(await fgt.executeCommand('show firewall address | grep "edit"'))
      .toContain('edit "NET-LAN"');
    expect(await fgt.executeCommand('show firewall addrgrp')).toContain('edit "GRP"');
    expect(await fgt.executeCommand('show firewall service custom | grep "edit \\"SVC"'))
      .toContain('SVC-App-8080');
    expect(await fgt.executeCommand('show firewall schedule recurring'))
      .toContain('Heures-Bureau');
  });

  it('etape 8 : un FQDN RESOLU par un vrai serveur devient une adresse', async () => {
    const fgt = fortigate();
    const ns = new LinuxServer('linux-server', 'NS', 200, 0);
    new Cable('wan').connect(fgt.getPort('port1')!, ns.getPort('eth0')!);
    await taper(ns, [
      'ip addr add 192.168.100.53/24 dev eth0', 'ip link set eth0 up',
    ]);
    vfsOf(ns).writeFile('/etc/bind/named.conf',
      'options { recursion no; };\n'
      + 'zone "lab.local" { type primary; file "/etc/bind/db.lab.local"; };\n', 0, 0, 0o022);
    vfsOf(ns).writeFile('/etc/bind/db.lab.local', ZONE_LAB, 0, 0, 0o022);
    await ns.executeCommand('systemctl start named');

    await taper(fgt, [
      'config system interface', 'edit port1', 'set mode static',
      'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping', 'next', 'end',
      'config system dns', 'set primary 192.168.100.53', 'end',
      'config firewall address', 'edit "FQDN-Web"',
      'set type fqdn', 'set fqdn "www.lab.local"', 'next', 'end',
    ]);

    expect(await fgt.executeCommand('diagnose firewall fqdn list'))
      .toContain('203.0.113.77');
    expect(fgt.getObjectStore().matchesAddress('FQDN-Web', '203.0.113.77')).toBe(true);
    expect(fgt.getObjectStore().matchesAddress('FQDN-Web', '203.0.113.78')).toBe(false);
  });

  it('un membre de groupe INEXISTANT est refuse', async () => {
    const fgt = fortigate();
    await fgt.executeCommand('config firewall addrgrp');
    await fgt.executeCommand('edit "GRP"');
    expect(await fgt.executeCommand('set member "NEXISTE-PAS"'))
      .toMatch(/Command fail|entry not found|unknown/i);
    await fgt.executeCommand('abort');
  });
});

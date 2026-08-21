import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { FirewallDnsServer } from '@/network/devices/firewall/l3/FirewallDnsServer';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { buildLegacyQueryMessage } from '@/network/dns/compat/DnsWireCompat';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';

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

function demander(serveur: FirewallDnsServer, nom: string): void {
  const requete = encodeDnsMessage(buildLegacyQueryMessage(1234, nom, 'A'));
  serveur.handleUdp('port2', { sourceIP: new IPAddress('192.168.10.50') } as never, {
    type: 'udp', sourcePort: 5300, destinationPort: 53,
    length: 8 + requete.length, checksum: 0, payload: requete,
  } as never);
}

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const srvDmz = new LinuxServer('linux-server', 'SRV-DMZ', 200, 0);

  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srvDmz.getPort('eth0')!);

  await taper(srvDmz, [
    'ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1',
  ]);
  await srvDmz.executeCommand('systemctl start nginx');
  await taper(pcLan, ['ip link set eth0 up']);

  await taper(fgt, [
    'config system interface',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
    'config firewall address',
    'edit "NET-LAN"', 'set subnet 192.168.10.0 255.255.255.0', 'next',
    'edit "NET-DMZ"', 'set subnet 192.168.20.0 255.255.255.0', 'next',
    'end',
    'config firewall policy', 'edit 2',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "NET-LAN"', 'set dstaddr "NET-DMZ"',
    'set service "ALL"', 'set schedule "always"',
    'set action accept', 'next', 'end',
  ]);
  return { fgt, pcLan, srvDmz };
}

async function serveurDhcp(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config system dhcp server', 'edit 1',
    'set interface "port2"',
    'set default-gateway 192.168.10.1',
    'set netmask 255.255.255.0',
    'set lease-time 86400',
    'config ip-range', 'edit 1',
    'set start-ip 192.168.10.100',
    'set end-ip 192.168.10.199',
    'next', 'end',
    'set dns-service default',
    'set status enable',
    'next', 'end',
  ]);
}

describe('TP 10 — rendre le reseau autonome', () => {
  it('etape 1 : le serveur DHCP se declare et se relit', async () => {
    const { fgt } = await laboratoire();
    propre(await serveurDhcp(fgt));
    const conf = await fgt.executeCommand('show system dhcp server');
    expect(conf).toContain('set interface "port2"');
    expect(conf).toContain('set default-gateway 192.168.10.1');
    expect(conf).toContain('set start-ip 192.168.10.100');
    expect(conf).toContain('set end-ip 192.168.10.199');
    expect(conf).toContain('set lease-time 86400');
  });

  it('etape 2 : le PC obtient VRAIMENT une adresse de la plage', async () => {
    const { fgt, pcLan } = await laboratoire();
    await serveurDhcp(fgt);

    await pcLan.executeCommand('dhclient -v eth0');
    const adresses = await pcLan.executeCommand('ip addr show eth0');
    expect(adresses).toMatch(/inet 192\.168\.10\.1\d{2}\//);
  });

  it('etape 2 : le client recoit AUSSI la passerelle', async () => {
    const { fgt, pcLan } = await laboratoire();
    await serveurDhcp(fgt);
    await pcLan.executeCommand('dhclient -v eth0');

    expect(await pcLan.executeCommand('ip route show'))
      .toContain('default via 192.168.10.1');
  });

  it('etape 2 : la sequence DORA passe sur le fil', async () => {
    const { fgt, pcLan } = await laboratoire();
    await serveurDhcp(fgt);
    await pcLan.executeCommand('dhclient -v eth0');

    const capture = await fgt.executeCommand(
      "diagnose sniffer packet port2 'udp port 67 or udp port 68' 4 20");
    expect(capture).not.toMatch(/Unknown action/i);
    expect(capture).toContain('.68 ->');
    expect(capture).toContain('.67');
  });

  it('etape 3 : `execute dhcp lease-list` montre le bail', async () => {
    const { fgt, pcLan } = await laboratoire();
    await serveurDhcp(fgt);
    await pcLan.executeCommand('dhclient -v eth0');

    const baux = await fgt.executeCommand('execute dhcp lease-list port2');
    expect(baux).not.toMatch(/Unknown action/i);
    expect(baux).toMatch(/192\.168\.10\.1\d{2}/);
  });

  it('etape 4 : une RESERVATION force l\'adresse', async () => {
    const { fgt, pcLan } = await laboratoire();
    await serveurDhcp(fgt);
    const mac = pcLan.getPort('eth0')!.getMAC().toString();

    propre(await taper(fgt, [
      'config system dhcp server', 'edit 1',
      'config reserved-address', 'edit 1',
      'set ip 192.168.10.50',
      `set mac ${mac}`,
      'set description "Poste de test du LAN"',
      'next', 'end',
      'next', 'end',
    ]));

    await pcLan.executeCommand('dhclient -v eth0');
    expect(await pcLan.executeCommand('ip addr show eth0'))
      .toContain('inet 192.168.10.50/');
  });

  it('etape 4 : `execute dhcp lease-clear` libere une adresse', async () => {
    const { fgt, pcLan } = await laboratoire();
    await serveurDhcp(fgt);
    await pcLan.executeCommand('dhclient -v eth0');

    const avant = await fgt.executeCommand('execute dhcp lease-list port2');
    const adresse = /192\.168\.10\.1\d{2}/.exec(avant)?.[0] ?? '';
    expect(adresse).not.toBe('');

    propre(await taper(fgt, [`execute dhcp lease-clear ${adresse}`]));
    expect(await fgt.executeCommand('execute dhcp lease-list port2'))
      .not.toContain(adresse);
  });

  it('etape 5 : le client DNS du pare-feu se declare', async () => {
    const { fgt } = await laboratoire();
    propre(await taper(fgt, [
      'config system dns', 'set primary 9.9.9.9', 'set secondary 1.1.1.1', 'end',
    ]));
    const conf = await fgt.executeCommand('show system dns');
    expect(conf).toContain('set primary 9.9.9.9');
    expect(conf).toContain('set secondary 1.1.1.1');
  });

  it('etape 6 : `config system dns-server` declare le service sur une interface',
    async () => {
      const { fgt } = await laboratoire();
      propre(await taper(fgt, [
        'config system dns-server', 'edit "port2"',
        'set mode forward-only', 'next', 'end',
      ]));
      expect(await fgt.executeCommand('show system dns-server'))
        .toContain('edit "port2"');
    });

  it('etape 7 : une zone locale se declare avec ses entrees', async () => {
    const { fgt } = await laboratoire();
    propre(await taper(fgt, [
      'config system dns-database', 'edit "lab-local"',
      'set domain "lab.local"',
      'set type primary',
      'set view shadow',
      'set authoritative disable',
      'config dns-entry',
      'edit 1', 'set hostname "srv-web"', 'set ip 192.168.20.10', 'next',
      'edit 2', 'set hostname "fgt"', 'set ip 192.168.10.1', 'next',
      'end',
      'next', 'end',
    ]));
    const conf = await fgt.executeCommand('show system dns-database');
    expect(conf).toContain('set domain "lab.local"');
    expect(conf).toContain('set hostname "srv-web"');
    expect(conf).toContain('set ip 192.168.20.10');
  });

  it('etape 8 : le pare-feu REPOND a une requete de sa zone locale', async () => {
    const { fgt, pcLan } = await laboratoire();
    await serveurDhcp(fgt);
    await pcLan.executeCommand('dhclient -v eth0');
    await taper(fgt, [
      'config system dns-server', 'edit "port2"', 'set mode forward-only', 'next', 'end',
      'config system dns-database', 'edit "lab-local"',
      'set domain "lab.local"', 'set type primary',
      'config dns-entry',
      'edit 1', 'set hostname "srv-web"', 'set ip 192.168.20.10', 'next',
      'end', 'next', 'end',
    ]);

    const reponse = await pcLan.executeCommand('dig @192.168.10.1 srv-web.lab.local');
    expect(reponse).toContain('192.168.20.10');
  });

  it('etape 8 : le nom resolu MENE au serveur', async () => {
    const { fgt, pcLan } = await laboratoire();
    await serveurDhcp(fgt);
    await taper(fgt, [
      'config system dhcp server', 'edit 1', 'set dns-service local', 'next', 'end',
    ]);
    await pcLan.executeCommand('dhclient -v eth0');
    await taper(fgt, [
      'config system dns-server', 'edit "port2"', 'set mode forward-only', 'next', 'end',
      'config system dns-database', 'edit "lab-local"',
      'set domain "lab.local"', 'set type primary',
      'config dns-entry',
      'edit 1', 'set hostname "srv-web"', 'set ip 192.168.20.10', 'next',
      'end', 'next', 'end',
    ]);

    expect(await pcLan.executeCommand('curl -sS http://srv-web.lab.local/'))
      .toContain('Welcome to nginx!');
  });

  it('etape 8 : une zone AUTORITAIRE refuse un nom absent au lieu de le renvoyer dehors',
    () => {
      const dehors: string[] = [];
      let rendu: Uint8Array | null = null;
      const serveur = new FirewallDnsServer({
        resolveExternal: (name) => { dehors.push(name); return ['203.0.113.9']; },
        reply: (_i, _t, _p, payload) => { rendu = payload; },
      });
      serveur.applyInterface({ iface: 'port2', mode: 'forward-only' });
      serveur.applyZone({
        name: 'lab-local', domain: 'lab.local', type: 'primary', authoritative: true,
        entries: [{ hostname: 'srv-web', ip: '192.168.20.10' }],
      });

      demander(serveur, 'absent.lab.local');
      expect(rendu).not.toBeNull();
      expect(decodeDnsMessage(rendu!).flags.rcode).toBe(DnsRcode.NXDOMAIN);
      expect(dehors).toHaveLength(0);
    });

  it('etape 8 : un nom HORS zone locale part vers le resolveur amont', () => {
    const dehors: string[] = [];
    let rendu: Uint8Array | null = null;
    const serveur = new FirewallDnsServer({
      resolveExternal: (name) => { dehors.push(name); return ['203.0.113.9']; },
      reply: (_i, _t, _p, payload) => { rendu = payload; },
    });
    serveur.applyInterface({ iface: 'port2', mode: 'forward-only' });
    serveur.applyZone({
      name: 'lab-local', domain: 'lab.local', type: 'primary', authoritative: true,
      entries: [{ hostname: 'srv-web', ip: '192.168.20.10' }],
    });

    demander(serveur, 'www.exemple.fr');
    expect(dehors).toEqual(['www.exemple.fr']);
    expect(decodeDnsMessage(rendu!).flags.rcode).toBe(DnsRcode.NOERROR);
  });

  it('etape 10 : `diagnose test application dnsproxy 3` rend l\'etat des serveurs',
    async () => {
      const { fgt } = await laboratoire();
      await taper(fgt, [
        'config system dns', 'set primary 9.9.9.9', 'set secondary 1.1.1.1', 'end',
      ]);
      const vue = await fgt.executeCommand('diagnose test application dnsproxy 3');
      expect(vue).not.toMatch(/Unknown action/i);
      expect(vue).toContain('9.9.9.9');
      expect(vue).toContain('1.1.1.1');
    });
});

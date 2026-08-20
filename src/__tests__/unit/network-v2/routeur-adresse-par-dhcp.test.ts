import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { IPAddress, SubnetMask } from '@/network/core/types';
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

async function taper(d: { executeCommand(c: string): Promise<string> }, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

async function serveurCisco(
  nom: string, iface: string, ip: string, reseau: string, passerelle: string,
): Promise<CiscoRouter> {
  const s = new CiscoRouter(nom, 0, 0);
  await taper(s, [
    'enable', 'configure terminal',
    `interface ${iface}`, `ip address ${ip} 255.255.255.0`, 'no shutdown', 'exit',
    `ip dhcp excluded-address ${ip}`,
    `ip dhcp pool ${nom}`,
    `network ${reseau} 255.255.255.0`,
    `default-router ${passerelle}`,
    'dns-server 8.8.8.8',
    'exit', 'end',
  ]);
  return s;
}

function ipDe(d: CiscoRouter | HuaweiRouter, iface: string): string | null {
  return d.getPort(iface)?.getIPAddress()?.toString() ?? null;
}

describe('un routeur Cisco prend son adresse par DHCP', () => {
  it('le serveur est deja la : la commande obtient une adresse du bon reseau', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '192.168.50.1', '192.168.50.0', '192.168.50.1');
    const r = new CiscoRouter('R1', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4, 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);

    await taper(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address dhcp', 'end',
    ]);

    const ip = ipDe(r, 'GigabitEthernet0/0');
    expect(ip).not.toBeNull();
    expect(ip!.startsWith('192.168.50.')).toBe(true);
    expect(r.getPort('GigabitEthernet0/0')!.getSubnetMask()!.toString()).toBe('255.255.255.0');
  });

  it('le serveur arrive APRES : l\'interface finit par obtenir une adresse', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await taper(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address dhcp', 'end',
    ]);
    expect(ipDe(r, 'GigabitEthernet0/0')).toBeNull();

    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '192.168.60.1', '192.168.60.0', '192.168.60.1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4, 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);

    expect(ipDe(r, 'GigabitEthernet0/0')?.startsWith('192.168.60.')).toBe(true);
  });

  it('deux serveurs sur le meme lien : UNE seule adresse, prise chez l\'un des deux', async () => {
    const a = await serveurCisco('SRVA', 'GigabitEthernet0/0', '10.1.0.1', '10.1.0.0', '10.1.0.1');
    const b = await serveurCisco('SRVB', 'GigabitEthernet0/0', '10.1.0.2', '10.1.0.0', '10.1.0.2');
    const r = new CiscoRouter('R1', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4, 0, 0);
    new Cable('a').connect(a.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(b.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/3')!);

    await taper(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address dhcp', 'end',
    ]);

    const ip = ipDe(r, 'GigabitEthernet0/0');
    expect(ip).not.toBeNull();
    expect(ip!.startsWith('10.1.0.')).toBe(true);

    const bailA = (await a.executeCommand('show ip dhcp binding')).includes(ip!);
    const bailB = (await b.executeCommand('show ip dhcp binding')).includes(ip!);
    expect(bailA !== bailB).toBe(true);
  });

  it('une interface eteinte n\'obtient rien, et l\'allumer declenche la demande', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '192.168.70.1', '192.168.70.0', '192.168.70.1');
    const r = new CiscoRouter('R1', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4, 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);

    await taper(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'shutdown', 'ip address dhcp',
    ]);
    expect(ipDe(r, 'GigabitEthernet0/0')).toBeNull();

    await r.executeCommand('no shutdown');
    expect(ipDe(r, 'GigabitEthernet0/0')?.startsWith('192.168.70.')).toBe(true);
  });

  it('la route par defaut apprise du serveur est installee', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '192.168.80.1', '192.168.80.0', '192.168.80.1');
    const r = new CiscoRouter('R1', 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, r.getPort('GigabitEthernet0/0')!);
    await taper(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address dhcp', 'end',
    ]);
    const routes = await r.executeCommand('show ip route');
    expect(routes).toMatch(/0\.0\.0\.0\/0|Gateway of last resort is 192\.168\.80\.1/);
  });

  it('l\'adresse apprise fait vraiment passer un ping', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '192.168.90.1', '192.168.90.0', '192.168.90.1');
    const r = new CiscoRouter('R1', 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, r.getPort('GigabitEthernet0/0')!);
    await taper(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address dhcp', 'end',
    ]);
    expect(await r.executeCommand('ping 192.168.90.1')).toMatch(/Success rate is (80|100) percent/);
  });

  it('`show ip interface brief` annonce la methode DHCP', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await taper(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address dhcp', 'end',
    ]);
    const ligne = (await r.executeCommand('show ip interface brief'))
      .split('\n').find(l => l.startsWith('GigabitEthernet0/0'))!;
    expect(ligne).toMatch(/DHCP/);
  });

  it('la configuration rendue porte `ip address dhcp`, pas l\'adresse apprise', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '192.168.55.1', '192.168.55.0', '192.168.55.1');
    const r = new CiscoRouter('R1', 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, r.getPort('GigabitEthernet0/0')!);
    await taper(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address dhcp', 'end',
    ]);
    const conf = await r.executeCommand('show running-config');
    const lignes = conf.split('\n');
    const d = lignes.indexOf('interface GigabitEthernet0/0');
    const bloc = lignes.slice(d + 1, lignes.indexOf('!', d)).map(l => l.trim());
    expect(bloc).toContain('ip address dhcp');
    expect(bloc.some(l => /^ip address 192\.168\.55\./.test(l))).toBe(false);
  });

  it('`show dhcp lease` decrit le bail obtenu', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '192.168.51.1', '192.168.51.0', '192.168.51.1');
    const r = new CiscoRouter('R1', 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, r.getPort('GigabitEthernet0/0')!);
    await taper(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address dhcp', 'end',
    ]);
    const bail = await r.executeCommand('show dhcp lease');
    expect(bail).toMatch(/Temp IP addr: 192\.168\.51\./);
    expect(bail).toMatch(/Interface: GigabitEthernet0\/0/);
    expect(bail).toMatch(/Temp\s+sub net mask: 255\.255\.255\.0/);
    expect(bail).toMatch(/DHCP Lease server: 192\.168\.51\.1/);
    expect(bail).toMatch(/state: 3 Bound/);
  });

  it('`release dhcp` rend l\'adresse et `renew dhcp` en reprend une', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '192.168.52.1', '192.168.52.0', '192.168.52.1');
    const r = new CiscoRouter('R1', 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, r.getPort('GigabitEthernet0/0')!);
    await taper(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address dhcp', 'end',
    ]);
    expect(ipDe(r, 'GigabitEthernet0/0')).not.toBeNull();

    await r.executeCommand('release dhcp GigabitEthernet0/0');
    expect(ipDe(r, 'GigabitEthernet0/0')).toBeNull();

    await r.executeCommand('renew dhcp GigabitEthernet0/0');
    expect(ipDe(r, 'GigabitEthernet0/0')?.startsWith('192.168.52.')).toBe(true);
  });

  it('`no ip address dhcp` arrete le client et retire l\'adresse', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '192.168.53.1', '192.168.53.0', '192.168.53.1');
    const r = new CiscoRouter('R1', 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, r.getPort('GigabitEthernet0/0')!);
    await taper(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address dhcp',
    ]);
    expect(ipDe(r, 'GigabitEthernet0/0')).not.toBeNull();

    await r.executeCommand('no ip address dhcp');
    expect(ipDe(r, 'GigabitEthernet0/0')).toBeNull();
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).not.toContain('ip address dhcp');
  });

  it('une adresse posee a la main REMPLACE le client DHCP', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '192.168.54.1', '192.168.54.0', '192.168.54.1');
    const r = new CiscoRouter('R1', 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, r.getPort('GigabitEthernet0/0')!);
    await taper(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address dhcp',
      'ip address 10.9.9.9 255.255.255.0', 'end',
    ]);
    expect(ipDe(r, 'GigabitEthernet0/0')).toBe('10.9.9.9');
    const conf = await r.executeCommand('show running-config');
    expect(conf).toContain('ip address 10.9.9.9 255.255.255.0');
    expect(conf).not.toContain('ip address dhcp');
  });

  it('deux interfaces peuvent etre clientes en meme temps, chacune sur son lien', async () => {
    const a = await serveurCisco('SRVA', 'GigabitEthernet0/0', '172.16.1.1', '172.16.1.0', '172.16.1.1');
    const b = await serveurCisco('SRVB', 'GigabitEthernet0/0', '172.16.2.1', '172.16.2.0', '172.16.2.1');
    const r = new CiscoRouter('R1', 0, 0);
    new Cable('a').connect(a.getPort('GigabitEthernet0/0')!, r.getPort('GigabitEthernet0/0')!);
    new Cable('b').connect(b.getPort('GigabitEthernet0/0')!, r.getPort('GigabitEthernet0/1')!);
    await taper(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'no shutdown', 'ip address dhcp', 'exit',
      'interface GigabitEthernet0/1', 'no shutdown', 'ip address dhcp', 'end',
    ]);
    expect(ipDe(r, 'GigabitEthernet0/0')?.startsWith('172.16.1.')).toBe(true);
    expect(ipDe(r, 'GigabitEthernet0/1')?.startsWith('172.16.2.')).toBe(true);
  });
});

describe('un routeur Huawei prend son adresse par DHCP', () => {
  it('`ip address dhcp-alloc` obtient une adresse du serveur present', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '192.168.61.1', '192.168.61.0', '192.168.61.1');
    const r = new HuaweiRouter('RH', 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, r.getPort('GE0/0/0')!);
    const sorties = await taper(r, [
      'system-view', 'interface GigabitEthernet0/0/0',
      'undo shutdown', 'ip address dhcp-alloc', 'return',
    ]);
    expect(sorties.join('')).not.toContain('Error:');
    expect(ipDe(r, 'GE0/0/0')?.startsWith('192.168.61.')).toBe(true);
  });

  it('la configuration rendue porte `ip address dhcp-alloc`', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '192.168.62.1', '192.168.62.0', '192.168.62.1');
    const r = new HuaweiRouter('RH', 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, r.getPort('GE0/0/0')!);
    await taper(r, [
      'system-view', 'interface GigabitEthernet0/0/0',
      'undo shutdown', 'ip address dhcp-alloc', 'return',
    ]);
    const conf = await r.executeCommand('display current-configuration');
    expect(conf).toContain('ip address dhcp-alloc');
    expect(conf).not.toMatch(/ip address 192\.168\.62\./);
  });

  it('`display dhcp client` decrit le bail', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '192.168.63.1', '192.168.63.0', '192.168.63.1');
    const r = new HuaweiRouter('RH', 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, r.getPort('GE0/0/0')!);
    await taper(r, [
      'system-view', 'interface GigabitEthernet0/0/0',
      'undo shutdown', 'ip address dhcp-alloc', 'return',
    ]);
    const vue = await r.executeCommand('display dhcp client');
    expect(vue).toContain('GigabitEthernet0/0/0');
    expect(vue).toMatch(/Bound/);
    expect(vue).toMatch(/192\.168\.63\./);
  });

  it('VRP n\'admet le client DHCP que sur UNE interface a la fois', async () => {
    const r = new HuaweiRouter('RH', 0, 0);
    await taper(r, [
      'system-view', 'interface GigabitEthernet0/0/0', 'ip address dhcp-alloc', 'quit',
      'interface GigabitEthernet0/0/1',
    ]);
    expect(await r.executeCommand('ip address dhcp-alloc')).toContain('Error:');
  });

  it('`undo ip address dhcp-alloc` retire le client et l\'adresse', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '192.168.64.1', '192.168.64.0', '192.168.64.1');
    const r = new HuaweiRouter('RH', 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, r.getPort('GE0/0/0')!);
    await taper(r, [
      'system-view', 'interface GigabitEthernet0/0/0',
      'undo shutdown', 'ip address dhcp-alloc',
    ]);
    expect(ipDe(r, 'GE0/0/0')).not.toBeNull();
    await r.executeCommand('undo ip address dhcp-alloc');
    expect(ipDe(r, 'GE0/0/0')).toBeNull();
    await r.executeCommand('return');
    expect(await r.executeCommand('display current-configuration')).not.toContain('dhcp-alloc');
  });
});

describe('la meme interface cliente, quel que soit le SERVEUR en face', () => {
  async function clientCisco(port: { getMAC(): unknown }): Promise<CiscoRouter> {
    const r = new CiscoRouter('R1', 0, 0);
    new Cable(`c${Math.random()}`).connect(port as never, r.getPort('GigabitEthernet0/0')!);
    await taper(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address dhcp', 'end',
    ]);
    return r;
  }

  it('serveur Cisco', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '10.20.1.1', '10.20.1.0', '10.20.1.1');
    const r = await clientCisco(srv.getPort('GigabitEthernet0/0')!);
    expect(ipDe(r, 'GigabitEthernet0/0')?.startsWith('10.20.1.')).toBe(true);
  });

  it('serveur Huawei', async () => {
    const srv = new HuaweiRouter('SRVH', 0, 0);
    await taper(srv, [
      'system-view', 'dhcp enable',
      'ip pool LAN',
      'network 10.20.2.0 mask 255.255.255.0',
      'gateway-list 10.20.2.1',
      'excluded-ip-address 10.20.2.1',
      'quit',
      'interface GigabitEthernet0/0/0',
      'ip address 10.20.2.1 255.255.255.0',
      'dhcp select global', 'undo shutdown', 'return',
    ]);
    const r = await clientCisco(srv.getPort('GE0/0/0')!);
    expect(ipDe(r, 'GigabitEthernet0/0')?.startsWith('10.20.2.')).toBe(true);
  });

  it('serveur Windows', async () => {
    const srv = new WindowsServer('SRVW');
    srv.getPorts()[0].configureIP(new IPAddress('10.20.3.1'), new SubnetMask('255.255.255.0'));
    srv.setCurrentUser('Administrator');
    const sh = PowerShellSubShell.create(srv).subShell;
    const run = async (l: string) => (await sh.processLine(l)).output.join('\n');
    await run('Install-WindowsFeature DHCP');
    await run('Add-DhcpServerv4Scope -Name LAN -StartRange 10.20.3.100 -EndRange 10.20.3.200 -SubnetMask 255.255.255.0');

    const r = await clientCisco(srv.getPorts()[0]);
    expect(ipDe(r, 'GigabitEthernet0/0')?.startsWith('10.20.3.')).toBe(true);
  });

  it('serveur porte par un COMMUTATEUR de niveau 3', async () => {
    const srv = new CiscoSwitch('switch-cisco', 'SWSRV', 4, 0, 0);
    await taper(srv, [
      'enable', 'configure terminal',
      'interface Vlan1', 'ip address 10.20.4.1 255.255.255.0', 'no shutdown', 'exit',
      'ip dhcp excluded-address 10.20.4.1',
      'ip dhcp pool LAN',
      'network 10.20.4.0 255.255.255.0',
      'default-router 10.20.4.1',
      'exit', 'end',
    ]);
    const r = await clientCisco(srv.getPort('FastEthernet0/1')!);
    expect(ipDe(r, 'GigabitEthernet0/0')?.startsWith('10.20.4.')).toBe(true);
  });

  it('un commutateur simple entre les deux ne change rien', async () => {
    const srv = await serveurCisco('SRV', 'GigabitEthernet0/0', '10.20.5.1', '10.20.5.0', '10.20.5.1');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    const r = new CiscoRouter('R1', 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, sw.getPorts()[0]);
    new Cable('b').connect(r.getPort('GigabitEthernet0/0')!, sw.getPorts()[1]);
    await taper(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address dhcp', 'end',
    ]);
    expect(ipDe(r, 'GigabitEthernet0/0')?.startsWith('10.20.5.')).toBe(true);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
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

interface Machine { executeCommand(c: string): Promise<string> | string }

async function taper(d: Machine, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

async function serveur(reseau: string): Promise<CiscoRouter> {
  const s = new CiscoRouter('SRV', 0, 0);
  await taper(s, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', `ip address ${reseau}.1 255.255.255.0`, 'no shutdown', 'exit',
    `ip dhcp excluded-address ${reseau}.1`,
    'ip dhcp pool LAN', `network ${reseau}.0 255.255.255.0`, `default-router ${reseau}.1`,
    'dns-server 8.8.8.8', 'exit', 'end',
  ]);
  return s;
}

function lan(reseau: string) {
  return serveur(reseau).then(srv => {
    const sw = new GenericSwitch('switch-generic', `SW-${reseau}`);
    new Cable(`s-${reseau}`).connect(srv.getPorts()[0], sw.getPorts()[0]);
    let libre = 1;
    return {
      srv, sw,
      brancher(port: import('@/network/hardware/Port').Port) {
        new Cable(`c-${reseau}-${libre}`).connect(port, sw.getPorts()[libre]);
        libre += 1;
      },
    };
  });
}

describe('un client DHCP de chaque nature obtient une adresse', () => {
  it('routeur Cisco', async () => {
    const l = await lan('10.40.1');
    const r = new CiscoRouter('R1', 0, 0);
    l.brancher(r.getPort('GigabitEthernet0/0')!);
    await taper(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address dhcp', 'end']);
    expect(r.getPort('GigabitEthernet0/0')!.getIPAddress()?.toString()).toMatch(/^10\.40\.1\./);
  });

  it('routeur Huawei', async () => {
    const l = await lan('10.40.2');
    const r = new HuaweiRouter('RH', 0, 0);
    l.brancher(r.getPort('GE0/0/0')!);
    await taper(r, ['system-view', 'interface GigabitEthernet0/0/0',
      'undo shutdown', 'ip address dhcp-alloc', 'return']);
    expect(r.getPort('GE0/0/0')!.getIPAddress()?.toString()).toMatch(/^10\.40\.2\./);
  });

  it('PC Linux', async () => {
    const l = await lan('10.40.3');
    const pc = new LinuxPC('linux-pc', 'PC1');
    l.brancher(pc.getPorts()[0]);
    await pc.executeCommand('sudo dhclient eth0');
    expect(pc.getPorts()[0].getIPAddress()?.toString()).toMatch(/^10\.40\.3\./);
  });

  it('PC Windows', async () => {
    const l = await lan('10.40.4');
    const pc = new WindowsPC('windows-pc', 'WIN1');
    l.brancher(pc.getPorts()[0]);
    await pc.executeCommand('ipconfig /renew');
    expect(pc.getPorts()[0].getIPAddress()?.toString()).toMatch(/^10\.40\.4\./);
  });

  it('serveur Linux', async () => {
    const l = await lan('10.40.5');
    const srv = new LinuxServer('linux-server', 'SRVL', 0, 0);
    l.brancher(srv.getPorts()[0]);
    await srv.executeCommand('sudo dhclient eth0');
    expect(srv.getPorts()[0].getIPAddress()?.toString()).toMatch(/^10\.40\.5\./);
  });

  it('commutateur Cisco, par son interface de gestion', async () => {
    const l = await lan('10.40.6');
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4, 0, 0);
    l.brancher(sw.getPort('FastEthernet0/1')!);
    const sorties = await taper(sw, ['enable', 'configure terminal',
      'interface Vlan1', 'ip address dhcp', 'no shutdown', 'end']);
    expect(sorties.join('')).not.toMatch(/Invalid input/);
    expect(sw.getSvi(1)?.ip?.toString()).toMatch(/^10\.40\.6\./);
  });

  it('commutateur Huawei, par son Vlanif', async () => {
    const l = await lan('10.40.7');
    const sw = new HuaweiSwitch('switch-huawei', 'SW2', 4, 0, 0);
    l.brancher(sw.getPort('GigabitEthernet0/0/1')!);
    const sorties = await taper(sw, ['system-view', 'interface Vlanif1',
      'ip address dhcp-alloc', 'undo shutdown', 'return']);
    expect(sorties.join('')).not.toContain('Error:');
    expect(sw.getSvi(1)?.ip?.toString()).toMatch(/^10\.40\.7\./);
  });
});

describe('ce que chaque nature de client doit ENCORE savoir faire', () => {
  it('un PC Linux rend son bail et en reprend un', async () => {
    const l = await lan('10.41.1');
    const pc = new LinuxPC('linux-pc', 'PC1');
    l.brancher(pc.getPorts()[0]);
    await pc.executeCommand('sudo dhclient eth0');
    expect(pc.getPorts()[0].getIPAddress()).not.toBeNull();
    await pc.executeCommand('sudo dhclient -r eth0');
    expect(pc.getPorts()[0].getIPAddress()).toBeNull();
    await pc.executeCommand('sudo dhclient eth0');
    expect(pc.getPorts()[0].getIPAddress()?.toString()).toMatch(/^10\.41\.1\./);
  });

  it('un PC Windows rend son bail et en reprend un', async () => {
    const l = await lan('10.41.2');
    const pc = new WindowsPC('windows-pc', 'WIN1');
    l.brancher(pc.getPorts()[0]);
    await pc.executeCommand('ipconfig /renew');
    expect(pc.getPorts()[0].getIPAddress()).not.toBeNull();
    await pc.executeCommand('ipconfig /release');
    expect(pc.getPorts()[0].getIPAddress()).toBeNull();
    await pc.executeCommand('ipconfig /renew');
    expect(pc.getPorts()[0].getIPAddress()?.toString()).toMatch(/^10\.41\.2\./);
  });

  it('un commutateur Cisco rend `ip address dhcp` dans sa configuration', async () => {
    const l = await lan('10.41.3');
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4, 0, 0);
    l.brancher(sw.getPort('FastEthernet0/1')!);
    await taper(sw, ['enable', 'configure terminal', 'interface Vlan1',
      'ip address dhcp', 'no shutdown', 'end']);
    const conf = await sw.executeCommand('show running-config');
    expect(conf).toContain('ip address dhcp');
    expect(conf).not.toMatch(/ip address 10\.41\.3\./);
  });

  it('un commutateur Huawei rend `ip address dhcp-alloc` dans sa configuration', async () => {
    const l = await lan('10.41.4');
    const sw = new HuaweiSwitch('switch-huawei', 'SW2', 4, 0, 0);
    l.brancher(sw.getPort('GigabitEthernet0/0/1')!);
    await taper(sw, ['system-view', 'interface Vlanif1', 'ip address dhcp-alloc', 'return']);
    const conf = await sw.executeCommand('display current-configuration');
    expect(conf).toContain('ip address dhcp-alloc');
  });

  it('une adresse apprise par un commutateur le rend joignable', async () => {
    const l = await lan('10.41.5');
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4, 0, 0);
    l.brancher(sw.getPort('FastEthernet0/1')!);
    await taper(sw, ['enable', 'configure terminal', 'interface Vlan1',
      'ip address dhcp', 'no shutdown', 'end']);
    expect(await sw.executeCommand('ping 10.41.5.1'))
      .toMatch(/Success rate is (80|100) percent/);
  });

  it('deux clients de natures DIFFERENTES ne recoivent jamais la meme adresse', async () => {
    const l = await lan('10.41.6');
    const pc = new LinuxPC('linux-pc', 'PC1');
    const win = new WindowsPC('windows-pc', 'WIN1');
    const r = new CiscoRouter('R1', 0, 0);
    l.brancher(pc.getPorts()[0]);
    l.brancher(win.getPorts()[0]);
    l.brancher(r.getPort('GigabitEthernet0/0')!);

    await pc.executeCommand('sudo dhclient eth0');
    await win.executeCommand('ipconfig /renew');
    await taper(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address dhcp', 'end']);

    const adresses = [
      pc.getPorts()[0].getIPAddress()?.toString(),
      win.getPorts()[0].getIPAddress()?.toString(),
      r.getPort('GigabitEthernet0/0')!.getIPAddress()?.toString(),
    ];
    expect(adresses.every(a => a?.startsWith('10.41.6.'))).toBe(true);
    expect(new Set(adresses).size).toBe(3);
  });
});

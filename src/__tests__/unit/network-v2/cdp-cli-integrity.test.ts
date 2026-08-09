import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
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

describe('CDP CLI — never fabricates neighbors for non-CDP peers', () => {
  it('show cdp neighbors omits a cabled LinuxPC and WindowsPC', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    const pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const pc2 = new WindowsPC('windows-pc', 'PC2', 0, 0);
    new Cable('a').connect(sw.getPort('FastEthernet0/1')!, pc1.getPort('eth0')!);
    new Cable('b').connect(sw.getPort('FastEthernet0/2')!, pc2.getPort('eth0')!);

    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show cdp neighbors');
    expect(out).not.toMatch(/PC1/);
    expect(out).not.toMatch(/PC2/);
    expect(out).not.toMatch(/Linux Host/);
    expect(out).not.toMatch(/Windows Host/);
    expect(out).toMatch(/Total cdp entries displayed : 0/);
  });

  it('a port with no real CDP neighbor is never listed while no CDP packet was received — no incoherence', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    const pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
    new Cable('a').connect(sw.getPort('FastEthernet0/1')!, pc1.getPort('eth0')!);

    await sw.executeCommand('enable');
    const neighbors = await sw.executeCommand('show cdp neighbors');
    const cdpTraffic = await sw.executeCommand('show cdp traffic');

    expect(neighbors).not.toMatch(/PC1/);
    // Le compteur qui prouve la cohérence est celui de CDP, pas celui de
    // l'interface : un hôte parle dès son démarrage sans dire un mot de
    // CDP (LLMNR et mDNS s'annoncent sur leurs groupes IPv6, ce que
    // l'adresse de lien-local permet sans configuration). Compter les
    // paquets de l'interface confondait « rien reçu » avec « rien reçu
    // en CDP », et seul le second dit quelque chose ici.
    expect(cdpTraffic).toMatch(/Total packets output: \d+, Input: 0/);
  });

  it('two switches cabled together still see each other via real CDP frames', async () => {
    const sw1 = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    const sw2 = new CiscoSwitch('switch-cisco', 'Switch2', 8);
    new Cable('a').connect(sw1.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);

    await sw1.executeCommand('enable');
    const neighbors = await sw1.executeCommand('show cdp neighbors');
    const ifaceShow = await sw1.executeCommand('show interfaces FastEthernet0/1');

    expect(neighbors).toMatch(/Switch2/);
    expect(ifaceShow).not.toMatch(/^\s*0 packets input/m);
  });
});

describe('CDP CLI — show cdp entry', () => {
  it('show cdp entry <name> returns the neighbor detail block, not global CDP parameters', async () => {
    const sw1 = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    const sw2 = new CiscoSwitch('switch-cisco', 'Switch2', 8);
    new Cable('a').connect(sw1.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);

    await sw1.executeCommand('enable');
    const out = await sw1.executeCommand('show cdp entry Switch2');
    expect(out).toMatch(/Device ID: Switch2/);
    expect(out).not.toMatch(/Global CDP information/);
  });

  it('show cdp entry * returns every neighbor detail block', async () => {
    const r1 = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(sw2.getPort('FastEthernet0/1')!, sw.getPort('FastEthernet0/2')!);

    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show cdp entry *');
    expect(out).toMatch(/Device ID: R1/);
    expect(out).toMatch(/Device ID: SW2/);
    expect(out).not.toMatch(/Global CDP information/);
  });
});

describe('CDP CLI — show cdp neighbors detail carries real protocol fields', () => {
  it('includes Version, advertisement version and Duplex for a real CDP neighbor', async () => {
    const sw1 = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    const sw2 = new CiscoSwitch('switch-cisco', 'Switch2', 8);
    new Cable('a').connect(sw1.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);

    await sw1.executeCommand('enable');
    const out = await sw1.executeCommand('show cdp neighbors detail');
    expect(out).toMatch(/Version :/);
    expect(out).toMatch(/Cisco IOS Software/);
    expect(out).toMatch(/advertisement version: 2/);
    expect(out).toMatch(/Duplex: (full|half|auto)/);
  });

  it('includes Native VLAN when the peer link is a trunk', async () => {
    const sw1 = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    const sw2 = new CiscoSwitch('switch-cisco', 'Switch2', 8);
    await sw1.executeCommand('enable');
    await sw1.executeCommand('configure terminal');
    await sw1.executeCommand('interface FastEthernet0/1');
    await sw1.executeCommand('switchport mode trunk');
    await sw1.executeCommand('end');
    await sw2.executeCommand('enable');
    await sw2.executeCommand('configure terminal');
    await sw2.executeCommand('interface FastEthernet0/1');
    await sw2.executeCommand('switchport mode trunk');
    await sw2.executeCommand('end');
    new Cable('a').connect(sw1.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);

    const out = await sw1.executeCommand('show cdp neighbors detail');
    expect(out).toMatch(/Native VLAN: 1/);
  });
});

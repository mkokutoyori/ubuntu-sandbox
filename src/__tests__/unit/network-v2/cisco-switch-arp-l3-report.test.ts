import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters, createDevice } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function priv(sw: CiscoSwitch): Promise<CiscoSwitch> {
  await sw.executeCommand('enable');
  return sw;
}

describe('ARP/L3 report — show ip interface brief lists physical ports (Cat 2.1)', () => {
  it('all FastEthernet ports appear as unassigned, not just the SVIs', async () => {
    const sw = await priv(new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0));
    const out = await sw.executeCommand('show ip interface brief');
    expect(out).toContain('FastEthernet0/1');
    expect(out).toContain('FastEthernet0/24');
    const fa1 = out.split('\n').find(l => l.startsWith('FastEthernet0/1'));
    expect(fa1).toContain('unassigned');
    expect(out).toContain('Vlan1');
  });

  it('a connected port shows up/up, a bare port shows down/down', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0);
    const pc = new LinuxPC('pc1', 'PC1', 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPort('FastEthernet0/1')!);
    await priv(sw);
    const out = await sw.executeCommand('show ip interface brief');
    const fa1 = out.split('\n').find(l => l.startsWith('FastEthernet0/1'))!;
    const fa2 = out.split('\n').find(l => l.startsWith('FastEthernet0/2'))!;
    expect(fa1).not.toContain('down');
    expect(fa1).not.toContain('administratively');
    expect(fa2).toContain('down');
  });
});

describe('ARP/L3 report — real ARP packet counters via show ip traffic (Cat 3.2)', () => {
  it('an unconfigured switch reports zero ARP requests/replies', async () => {
    const sw = await priv(new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0));
    const out = await sw.executeCommand('show ip traffic');
    expect(out).toContain('ARP statistics:');
    expect(out).toContain('Rcvd: 0 requests, 0 replies');
  });

  it('ARP requests/replies from real inter-VLAN traffic increment the counters', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    const pc2 = new LinuxPC('pc2', 'PC2', 0, 0);
    new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(pc2.getPorts()[0], sw.getPort('FastEthernet0/2')!);
    pc1.getPorts()[0].configureIP(new IPAddress('10.0.10.10'), new SubnetMask('255.255.255.0'));
    pc2.getPorts()[0].configureIP(new IPAddress('10.0.20.10'), new SubnetMask('255.255.255.0'));
    pc1.setDefaultGateway(new IPAddress('10.0.10.1'));
    pc2.setDefaultGateway(new IPAddress('10.0.20.1'));

    for (const c of [
      'enable', 'configure terminal', 'ip routing',
      'vlan 10', 'exit', 'vlan 20', 'exit',
      'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 20', 'exit',
      'interface Vlan10', 'ip address 10.0.10.1 255.255.255.0', 'no shutdown', 'exit',
      'interface Vlan20', 'ip address 10.0.20.1 255.255.255.0', 'no shutdown', 'exit',
      'end',
    ]) await sw.executeCommand(c);

    await pc1.executeCommand('ping 10.0.20.10');

    const stats = sw._getArpStats();
    expect(stats.rxRequests + stats.rxReplies + stats.txRequests + stats.txReplies).toBeGreaterThan(0);

    const out = await sw.executeCommand('show ip traffic');
    const arpLine = out.split('\n').find(l => l.trim().startsWith('Rcvd:') && out.includes('ARP statistics'));
    expect(out).toContain('ARP statistics:');
    void arpLine;
    const rcvd = out.split('\n').filter(l => l.includes('requests'));
    expect(rcvd.length).toBeGreaterThan(0);
  });
});

describe('ARP/L3 report — WS-C2960-24TT-L exposes its 2 Gigabit uplinks (Cat 3.1)', () => {
  it('factory-built Cisco switch reports 24 FastEthernet + 2 Gigabit in show version', async () => {
    const sw = createDevice('switch-cisco') as CiscoSwitch;
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show version');
    expect(out).toContain('24 FastEthernet interfaces');
    expect(out).toContain('2 Gigabit Ethernet interfaces');
    expect(out).not.toContain('0 Gigabit Ethernet interfaces');
  });

  it('the Gigabit uplinks appear in show ip interface brief', async () => {
    const sw = createDevice('switch-cisco') as CiscoSwitch;
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show ip interface brief');
    expect(out).toContain('GigabitEthernet0/1');
    expect(out).toContain('GigabitEthernet0/2');
  });
});

describe('ARP/L3 report — interface-existence validation (Cat 2.2)', () => {
  it('show ip arp on a non-existent interface is rejected', async () => {
    const sw = await priv(new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0));
    const out = await sw.executeCommand('show ip arp gigabitEthernet 0/1');
    expect(out).toContain('Invalid input');
  });

  it('show mac address-table on a non-existent interface is rejected', async () => {
    const sw = await priv(new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0));
    const out = await sw.executeCommand('show mac address-table interface gigabitEthernet 0/1');
    expect(out).toContain('Invalid interface');
  });

  it('show ip arp on a real FastEthernet interface is accepted (empty table)', async () => {
    const sw = await priv(new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0));
    const out = await sw.executeCommand('show ip arp fastEthernet 0/1');
    expect(out).not.toContain('Invalid input');
    expect(out).toContain('No ARP entries');
  });
});

describe('ARP/L3 report — SVI validation consistency (Cat 2.3)', () => {
  it('show ip arp vlan N is rejected when the SVI does not exist', async () => {
    const sw = await priv(new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0));
    const arp = await sw.executeCommand('show ip arp vlan 10');
    const svi = await sw.executeCommand('show ip interface vlan 10');
    expect(arp).toContain('Invalid');
    expect(svi).toContain('Invalid');
  });

  it('show ip arp vlan N is accepted once the SVI is configured', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0);
    for (const c of ['enable', 'configure terminal', 'vlan 10', 'exit',
      'interface Vlan10', 'ip address 10.0.10.1 255.255.255.0', 'no shutdown', 'end']) {
      await sw.executeCommand(c);
    }
    const out = await sw.executeCommand('show ip arp vlan 10');
    expect(out).not.toContain('Invalid');
  });
});

describe('ARP/L3 report — show ip route reflects the ip routing state (Cat 3.3)', () => {
  it('reports the routing process as disabled by default on an L2 switch', async () => {
    const sw = await priv(new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0));
    const out = await sw.executeCommand('show ip route');
    expect(out).toContain('IP routing table is not enabled');
  });

  it('shows the routing table once ip routing is enabled', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0);
    for (const c of ['enable', 'configure terminal', 'ip routing',
      'interface Vlan1', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']) {
      await sw.executeCommand(c);
    }
    const out = await sw.executeCommand('show ip route');
    expect(out).not.toContain('IP routing table is not enabled');
    expect(out).toContain('Codes:');
  });
});

describe('ARP/L3 report — show ip arp summary is a distinct real structure (Cat 3.2)', () => {
  it('is not the lazy "No ARP entries" list and reports real counts', async () => {
    const sw = await priv(new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0));
    const out = await sw.executeCommand('show ip arp summary');
    expect(out).not.toContain('No ARP entries');
    expect(out).toContain('Total number of entries in the arp table:');
    expect(out).toContain('Total number of Dynamic entries:');
  });

  it('reflects real ARP entries learned from inter-VLAN traffic', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    const pc2 = new LinuxPC('pc2', 'PC2', 0, 0);
    new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(pc2.getPorts()[0], sw.getPort('FastEthernet0/2')!);
    pc1.getPorts()[0].configureIP(new IPAddress('10.0.10.10'), new SubnetMask('255.255.255.0'));
    pc2.getPorts()[0].configureIP(new IPAddress('10.0.20.10'), new SubnetMask('255.255.255.0'));
    pc1.setDefaultGateway(new IPAddress('10.0.10.1'));
    pc2.setDefaultGateway(new IPAddress('10.0.20.1'));
    for (const c of [
      'enable', 'configure terminal', 'ip routing',
      'vlan 10', 'exit', 'vlan 20', 'exit',
      'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 20', 'exit',
      'interface Vlan10', 'ip address 10.0.10.1 255.255.255.0', 'no shutdown', 'exit',
      'interface Vlan20', 'ip address 10.0.20.1 255.255.255.0', 'no shutdown', 'exit',
      'end',
    ]) await sw.executeCommand(c);
    await pc1.executeCommand('ping 10.0.20.10');
    const out = await sw.executeCommand('show ip arp summary');
    expect(out).toMatch(/Total number of entries in the arp table: [1-9]/);
  });
});

describe('ARP/L3 report — show ip device tracking (Cat 1.1)', () => {
  it('is implemented and returns the tracking table, not an invalid-input marker', async () => {
    const sw = await priv(new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0));
    const out = await sw.executeCommand('show ip device tracking all');
    expect(out).not.toContain('Invalid input');
    expect(out).toContain('Global IP Device Tracking for clients');
    expect(out).toContain('Total number of entries:');
  });
});

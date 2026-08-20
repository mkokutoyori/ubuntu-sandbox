import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { C3560_SOFTWARE } from '@/network/devices/shells/cisco/CiscoPlatform';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

function freshSwitch(): CiscoSwitch {
  return new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0);
}

async function priv(sw: CiscoSwitch): Promise<CiscoSwitch> {
  await sw.executeCommand('enable');
  return sw;
}

describe('L3 referential — the switch identifies as a Catalyst 3560 (L3/CEF-capable)', () => {
  it('show version reports the 3560 model and IOS image, not the C2960', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show version');
    expect(out).toContain('WS-C3560-24TS-S');
    expect(out).toContain(C3560_SOFTWARE.iosVersion);
    expect(out).not.toContain('WS-C2960');
  });

  it('the boot banner matches show version (single source of truth)', async () => {
    const sw = freshSwitch();
    const boot = sw.getBootSequence();
    const version = await (await priv(sw)).executeCommand('show version');
    expect(boot).toContain(C3560_SOFTWARE.iosVersion);
    expect(version).toContain(C3560_SOFTWARE.iosVersion);
    expect(boot).not.toContain('C2960');
  });
});

describe('L3 referential — show ip route no longer rejects with an L2 message', () => {
  it('an L3 switch with no ip routing configured shows an empty routing table, not a rejection', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show ip route');
    expect(out).not.toContain('IP routing table is not enabled');
    expect(out).toContain('Codes:');
    expect(out).toContain('Gateway of last resort is not set');
  });

  it('still shows real connected routes once an SVI has an IP', async () => {
    const sw = freshSwitch();
    for (const c of ['enable', 'configure terminal', 'ip routing',
      'interface Vlan1', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']) {
      await sw.executeCommand(c);
    }
    const out = await sw.executeCommand('show ip route');
    expect(out).toContain('directly connected, Vlan1');
  });
});

describe('L3 referential — show adjacency is a real, working CEF command', () => {
  it('show adjacency is not rejected on the L3 switch', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show adjacency');
    expect(out).not.toMatch(/not supported on this platform/);
    expect(out).not.toMatch(/Invalid input detected/);
  });

  it('show adjacency detail and summary are also accepted', async () => {
    const sw = await priv(freshSwitch());
    const detail = await sw.executeCommand('show adjacency detail');
    const summary = await sw.executeCommand('show adjacency summary');
    expect(detail).not.toMatch(/Invalid input detected/);
    expect(summary).not.toMatch(/Invalid input detected/);
    expect(summary).toContain('Total number of adjacencies');
  });

  it('reflects a real ARP-learned neighbor as a CEF adjacency', async () => {
    const sw = freshSwitch();
    for (const c of ['enable', 'configure terminal', 'ip routing',
      'interface Vlan1', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'arp 10.0.0.9 0050.7966.6801 arpa', 'end']) {
      await sw.executeCommand(c);
    }
    const out = await sw.executeCommand('show adjacency');
    expect(out).toContain('10.0.0.9');
    expect(out).toContain('0050.7966.6801');
  });
});

describe('L3 referential — show spanning-tree detail includes the previously missing fields', () => {
  it('reports Port Identifier, Designated root/bridge, Timers, transitions, link type, BPDU counts', async () => {
    const sw1 = freshSwitch();
    const sw2 = new CiscoSwitch('switch-cisco', 'Switch2', 24, 0, 0);
    const { Cable } = await import('@/network/hardware/Cable');
    new Cable('c1').connect(sw1.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
    await sw1.executeCommand('enable');
    await new Promise(r => setTimeout(r, 50));
    const out = await sw1.executeCommand('show spanning-tree detail');
    expect(out).toMatch(/Port Identifier 128\.\d+\./);
    expect(out).toMatch(/Designated root has priority \d+, address [0-9a-f.]+/);
    expect(out).toMatch(/Designated bridge has priority \d+, address [0-9a-f.]+/);
    expect(out).toMatch(/Timers: message age \d+, forward delay \d+, hold \d+/);
    expect(out).toMatch(/Number of transitions to forwarding state: \d+/);
    expect(out).toMatch(/Link type is (point-to-point|shared) by default/);
    expect(out).toMatch(/BPDU: sent \d+, received \d+/);
  });
});

describe('L3 referential — residual colon MAC format is gone', () => {
  it('the boot banner MAC is in Cisco dotted format', async () => {
    const sw = freshSwitch();
    const boot = sw.getBootSequence();
    expect(boot).toMatch(/Base ethernet MAC address: [0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}/);
    expect(boot).not.toMatch(/[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}/);
  });

  it('show ip interface vlan 1 reports the SVI MAC in Cisco dotted format', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show ip interface vlan 1');
    expect(out).toMatch(/address is [0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}/);
    expect(out).not.toMatch(/[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}/);
  });
});

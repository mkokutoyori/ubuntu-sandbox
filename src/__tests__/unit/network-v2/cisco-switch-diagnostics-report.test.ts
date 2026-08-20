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

describe('C2960 diagnostics report — missing DHCP commands (Cat 1)', () => {
  const commands = [
    'show ip dhcp statistics',
    'show ip dhcp server statistics',
    'show ip dhcp conflict',
    'show ip dhcp excluded-address',
    'show ip dhcp lease',
    'show ip dhcp database',
    'show ip dhcp snooping statistics',
  ];

  for (const cmd of commands) {
    it(`"${cmd}" is implemented (no % Invalid input)`, async () => {
      const sw = await priv(freshSwitch());
      const out = await sw.executeCommand(cmd);
      expect(out).not.toContain('% Invalid input');
    });
  }

  it('snooping statistics reflect real datapath counters', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show ip dhcp snooping statistics');
    expect(out).toContain('Received on untrusted ports');
    expect(out).toContain('Source mac not equal to chaddr');
  });

  it('server statistics render the DHCP message counters', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show ip dhcp statistics');
    expect(out).toContain('DHCPDISCOVER');
    expect(out).toContain('DHCPOFFER');
  });

  it('show ip dhcp database reflects real configured agents (not a stub)', async () => {
    const sw = await priv(freshSwitch());
    expect(await sw.executeCommand('show ip dhcp database')).toBe('Database agents: 0');
    for (const c of ['configure terminal', 'ip dhcp database ftp://10.0.0.9/dhcp', 'end']) {
      await sw.executeCommand(c);
    }
    const out = await sw.executeCommand('show ip dhcp database');
    expect(out).toContain('Database agents: 1');
    expect(out).toContain('ftp://10.0.0.9/dhcp');
  });
});

describe('C2960 diagnostics report — version single source of truth (Cat 2.1)', () => {
  it('the boot banner and show version report the same IOS version', async () => {
    const sw = freshSwitch();
    const boot = sw.getBootSequence();
    const version = await (await priv(sw)).executeCommand('show version');
    expect(boot).toContain(C3560_SOFTWARE.iosVersion);
    expect(version).toContain(C3560_SOFTWARE.iosVersion);
    expect(boot).not.toContain('15.2(7)E2');
    expect(version).not.toContain('15.2(7)E2');
  });

  it('the flash image matches the reported version train', async () => {
    const version = await (await priv(freshSwitch())).executeCommand('show version');
    expect(version).toContain(C3560_SOFTWARE.image);
  });
});

describe('C2960 diagnostics report — SVI / VLAN / STP consistency (Cat 2.2, 2.3, 3.1)', () => {
  it('show ip interface for a non-existent SVI does not fabricate state', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show ip interface vlan 10');
    expect(out).not.toContain('svi not configured');
    expect(out).toContain('% Invalid interface');
  });

  it('show spanning-tree vlan for a non-existent VLAN reports no instance', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show spanning-tree vlan 10');
    expect(out).toContain('do not exist');
    expect(out).not.toContain('VLAN0010');
  });

  it('show spanning-tree vlan for a real VLAN still renders the instance', async () => {
    const sw = await priv(freshSwitch());
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('end');
    const out = await sw.executeCommand('show spanning-tree vlan 10');
    expect(out).toContain('VLAN0010');
  });

  it('show ip interface for a configured SVI still renders its state', async () => {
    const sw = await priv(freshSwitch());
    for (const c of ['configure terminal', 'vlan 10', 'exit',
      'interface Vlan10', 'ip address 10.0.10.1 255.255.255.0', 'no shutdown', 'end']) {
      await sw.executeCommand(c);
    }
    const out = await sw.executeCommand('show ip interface vlan 10');
    expect(out).toContain('Internet address is 10.0.10.1');
    expect(out).not.toContain('% Invalid interface');
  });
});

describe('C2960 diagnostics report — ping source without IP (Cat 2.4)', () => {
  it('ping source vlan with no IP is rejected before sending', async () => {
    const sw = await priv(freshSwitch());
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('end');
    const out = await sw.executeCommand('ping 192.168.10.1 source vlan 10');
    expect(out).toContain('no IP address');
    expect(out).not.toContain('Sending 5');
  });
});

describe('C2960 diagnostics report — show interface vlan (Cat 2.5)', () => {
  it('show interfaces vlan N renders a configured SVI', async () => {
    const sw = await priv(freshSwitch());
    for (const c of ['configure terminal', 'vlan 10', 'exit',
      'interface Vlan10', 'ip address 10.0.10.1 255.255.255.0', 'no shutdown', 'end']) {
      await sw.executeCommand(c);
    }
    const out = await sw.executeCommand('show interfaces vlan 10');
    expect(out).toContain('Vlan10 is');
    expect(out).toContain('EtherSVI');
  });

  it('show interface vlan N (abbreviated, no trailing s) also resolves the SVI', async () => {
    const sw = await priv(freshSwitch());
    for (const c of ['configure terminal', 'vlan 10', 'exit',
      'interface Vlan10', 'ip address 10.0.10.1 255.255.255.0', 'no shutdown', 'end']) {
      await sw.executeCommand(c);
    }
    const out = await sw.executeCommand('show interface vlan 10');
    expect(out).toContain('Vlan10 is');
    expect(out).not.toContain('% Invalid input');
  });
});

describe('C2960 diagnostics report — factually correct DHCP output (Cat 3.2, 3.3)', () => {
  it('empty show ip dhcp binding has no % prefix', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show ip dhcp binding');
    expect(out).not.toContain('% No bindings');
    expect(out).not.toContain('%');
  });

  it('a named pool that does not exist reports Pool <name> not found', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show ip dhcp pool COMPTA');
    expect(out).toContain('Pool COMPTA not found');
  });
});

describe('C2960 diagnostics report — complete output (Cat 4.1, 4.2, 4.3)', () => {
  it('show logging renders the full facility/severity block', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show logging');
    expect(out).toContain('Console logging:');
    expect(out).toContain('Buffer logging:');
    expect(out).toContain('Trap logging:');
    expect(out.split('\n').length).toBeGreaterThan(3);
  });

  it('show mac address-table vlan N keeps the separator and No entries line', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show mac address-table vlan 10');
    expect(out).toContain('Mac Address Table');
    expect(out).toContain('No entries.');
  });

  it('show interfaces trunk prints nothing when no port is trunking', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show interfaces trunk');
    expect(out.trim()).toBe('');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('MACAddress — Cisco dotted format', () => {
  it('toCiscoString formats as xxxx.xxxx.xxxx', () => {
    const mac = new MACAddress('aa:bb:cc:dd:ee:ff');
    expect(mac.toCiscoString()).toBe('aabb.ccdd.eeff');
  });
});

describe('Cisco switch — MAC address formatting is IOS dotted, not colon', () => {
  it('show interfaces reports the hardware address in dotted format', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show interfaces FastEthernet0/1');
    expect(out).toMatch(/address is [0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4} \(bia [0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\)/);
    expect(out).not.toMatch(/address is [0-9a-f]{2}:[0-9a-f]{2}/);
  });

  it('show version reports the base ethernet MAC in dotted format', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show version');
    expect(out).toMatch(/Base ethernet MAC Address\s*:\s*[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}/);
  });

  it('show ip arp reports the hardware address in dotted format', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('arp 192.168.1.50 0011.2233.4455 arpa');
    await sw.executeCommand('end');
    const out = await sw.executeCommand('show ip arp');
    expect(out).toMatch(/0011\.2233\.4455/);
    expect(out).not.toMatch(/00:11:22:33:44:55/);
  });
});

describe('Cisco switch — show ip interface vlan 1 matches show ip interface brief', () => {
  it('Vlan1 exists by default and both commands agree', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    const brief = await sw.executeCommand('show ip interface brief');
    expect(brief).toMatch(/Vlan1\s+unassigned\s+YES unset\s+administratively down down/);
    const verbose = await sw.executeCommand('show ip interface vlan 1');
    expect(verbose).not.toMatch(/% Invalid interface/);
    expect(verbose).toMatch(/Vlan1 is administratively down/);
  });
});

describe('Cisco switch — show ip route summary', () => {
  it('returns the route-source counter table, not "% No routes installed"', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show ip route summary');
    expect(out).not.toMatch(/% No routes installed/);
    expect(out).toMatch(/Route Source\s+Networks\s+Subnets\s+Replicates\s+Overhead\s+Memory/);
    expect(out).toMatch(/connected\s+0\s+0\s+0\s+0\s+0/);
    expect(out).toMatch(/Total\s+0\s+0\s+0\s+0\s+0/);
  });
});

describe('Cisco switch — show ip arp count/detail are real, consistent with summary', () => {
  it('show ip arp count reports the same total as summary', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show ip arp count');
    expect(out).not.toMatch(/% Invalid input detected/);
    expect(out).toMatch(/Total number of entries in the arp table: 0\./);
  });

  it('show ip arp detail reports the real table with per-entry detail, not rejected', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show ip arp detail');
    expect(out).not.toMatch(/% Invalid input detected/);
    expect(out).toMatch(/No ARP entries/);
  });
});

describe('Cisco switch — show ip arp summary reports real entry counts', () => {
  it('returns the entry-count summary derived from the real ARP table', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show ip arp summary');
    expect(out).not.toMatch(/% Invalid input detected/);
    expect(out).toMatch(/Total number of entries in the arp table: 0\./);
    expect(out).toMatch(/Total number of Dynamic entries: 0\./);
  });
});

describe('Cisco switch — show ip arp inspection log', () => {
  it('is accepted and returns a real DAI log buffer view, not rejected', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show ip arp inspection log');
    expect(out).not.toMatch(/Invalid input detected/);
    expect(out).toMatch(/Total Log Buffer Size/);
    expect(out).toMatch(/Interface\s+Vlan\s+Sender MAC/);
  });
});

describe('Cisco switch — show ip traffic', () => {
  it('is accepted on the switch shell and reports real port counters', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show ip traffic');
    expect(out).not.toMatch(/Invalid input detected/);
    expect(out).toMatch(/IP statistics:/);
  });
});

describe('Cisco switch — show adjacency', () => {
  it('is a real CEF adjacency command on this L3-capable switch, not rejected', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show adjacency');
    expect(out).not.toMatch(/Invalid input detected/);
    expect(out).not.toMatch(/not supported/i);
  });
});

describe('Cisco switch — show mac address-table notification', () => {
  it('returns notification service status, not the full MAC table', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show mac address-table notification');
    expect(out).toMatch(/MAC address table notification is disabled/);
    expect(out).toMatch(/Interval between Notification Traps/);
  });
});

describe('Cisco switch — default switchport mode access is not fabricated in running-config', () => {
  it('an unconfigured port does not show "switchport mode access"', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show running-config');
    const fa1Block = out.split('interface FastEthernet0/1')[1]?.split('interface ')[0] ?? '';
    expect(fa1Block).not.toMatch(/switchport mode access/);
  });

  it('a port explicitly set to access mode does show the line', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode access');
    await sw.executeCommand('end');
    const out = await sw.executeCommand('show running-config');
    const fa1Block = out.split('interface FastEthernet0/1')[1]?.split('interface ')[0] ?? '';
    expect(fa1Block).toMatch(/switchport mode access/);
  });

  it('show running-config interface FastEthernet0/1 omits the line by default', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show running-config interface FastEthernet0/1');
    expect(out).not.toMatch(/switchport mode access/);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function router(...setup: string[]): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  for (const c of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    ...setup, 'end']) await r.executeCommand(c);
  return r;
}

const occurrences = (text: string, needle: string): number =>
  text.split(needle).length - 1;

const OSPF = ['router ospf 1', 'router-id 1.1.1.1', 'network 10.0.0.0 0.0.0.255 area 0', 'exit'];
const RIP = ['router rip', 'version 2', 'network 10.0.0.0', 'exit'];

describe('a routing process is reported once, whatever else runs beside it', () => {
  it('OSPF alone', async () => {
    const r = await router(...OSPF);
    const out = String(await r.executeCommand('show ip protocols'));
    expect(occurrences(out, 'Routing Protocol is "ospf 1"')).toBe(1);
  });

  it('OSPF beside RIP — the case that hid the duplicate', async () => {
    const r = await router(...OSPF, ...RIP);
    const out = String(await r.executeCommand('show ip protocols'));

    expect(occurrences(out, 'Routing Protocol is "ospf 1"')).toBe(1);
    expect(occurrences(out, 'Routing Protocol is "rip"')).toBe(1);
  });

  it('RIP alone', async () => {
    const r = await router(...RIP);
    const out = String(await r.executeCommand('show ip protocols'));
    expect(occurrences(out, 'Routing Protocol is "rip"')).toBe(1);
    expect(out).not.toContain('ospf');
  });

  it('and a router running nothing says so', async () => {
    const r = await router();
    expect(String(await r.executeCommand('show ip protocols')))
      .toBe('No routing protocol is configured.');
  });
});

describe('the configuration writes what differs from the factory, not the factory', () => {
  it('the buffer is on out of the box, and the configuration stays silent about it', async () => {
    const r = await router();

    expect(String(await r.executeCommand('show logging')))
      .toContain('Buffer logging:  level debugging');
    expect(String(await r.executeCommand('show running-config')))
      .not.toContain('logging buffered');
  });

  it('resizing it makes the line appear', async () => {
    const r = await router('logging buffered 16384 informational');
    expect(String(await r.executeCommand('show running-config')))
      .toContain('logging buffered 16384 informational');
  });

  it('turning it off is written too, since silence would mean the default', async () => {
    const r = await router('no logging buffered');
    expect(String(await r.executeCommand('show running-config')))
      .toContain('no logging buffered');
  });
});

describe('no view leaks a JavaScript object into the terminal', () => {
  it('an IPv6 address renders as an address', async () => {
    const r = await router('interface GigabitEthernet0/0',
      'ipv6 address 2001:db8::1/64', 'exit');
    const brief = String(await r.executeCommand('show ipv6 interface brief'));

    expect(brief).toContain('2001:db8::1/64');
    expect(brief).not.toContain('[object Object]');
  });

  it('and neither does the verbose view', async () => {
    const r = await router('interface GigabitEthernet0/0',
      'ipv6 address 2001:db8::1/64', 'exit');
    expect(String(await r.executeCommand('show ipv6 interface GigabitEthernet0/0')))
      .not.toContain('[object Object]');
  });

  it('nor any of the routing views', async () => {
    const r = await router(...OSPF, ...RIP, 'ip route 192.168.50.0 255.255.255.0 10.0.12.2');
    for (const c of ['show ip route', 'show ip protocols', 'show ip cef',
      'show running-config', 'show ip interface brief']) {
      expect(String(await r.executeCommand(c)), c).not.toContain('[object Object]');
    }
  });
});

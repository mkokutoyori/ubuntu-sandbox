import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function cableToSwitch(pc: LinuxPC): CiscoSwitch {
  const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
  new Cable('w').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  return sw;
}

describe('ip addr show — loopback IPv6 scope', () => {
  it('::1/128 has scope host, not scope global', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('ip addr show lo');
    expect(out).toMatch(/inet6 ::1\/128 scope host/);
    expect(out).not.toMatch(/inet6 ::1\/128 scope global/);
  });
});

describe('ip addr show — auto link-local IPv6 on an active interface', () => {
  it('eth0 gets a fe80::/64 link-local address once cabled', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    cableToSwitch(pc);
    const out = await pc.executeCommand('ip addr show eth0');
    expect(out).toMatch(/inet6 fe80::[0-9a-f:]+(%eth0)?\/64 scope link/);
  });
});

describe('ip link show — includes the loopback interface', () => {
  it('lists lo as ifindex 1 with LOOPBACK flag', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('ip link show');
    expect(out).toMatch(/1: lo: <.*LOOPBACK/);
    expect(out).toMatch(/link\/loopback 00:00:00:00:00:00/);
  });
});

describe('ip -brief addr show — includes the loopback interface', () => {
  it('lists lo alongside the physical interfaces', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('ip -brief addr show');
    expect(out).toMatch(/^lo\s+UP/m);
  });
});

describe('/proc/sys/net/ipv4/arp_cache_size', () => {
  it('exists and reports a realistic value', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('cat /proc/sys/net/ipv4/arp_cache_size');
    expect(out.trim()).toBe('1024');
  });
});

describe('/proc/sys/net/ipv4/neigh/<iface>/ — per-interface ARP tunables', () => {
  it('gc_stale_time and base_reachable_time_ms exist for eth0', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const gcStale = await pc.executeCommand('cat /proc/sys/net/ipv4/neigh/eth0/gc_stale_time');
    const baseReachable = await pc.executeCommand('cat /proc/sys/net/ipv4/neigh/eth0/base_reachable_time_ms');
    expect(gcStale.trim()).toBe('60');
    expect(baseReachable.trim()).toBe('30000');
  });
});

describe('arp -n / arp -e on an empty table — the header still prints', () => {
  it('arp -n shows the tabular header even with zero entries', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('arp -n');
    expect(out).toMatch(/Address\s+HWtype\s+HWaddress\s+Flags Mask\s+Iface/);
  });

  it('arp -e shows the tabular header even with zero entries', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('arp -e');
    expect(out).toMatch(/Address\s+HWtype\s+HWaddress\s+Flags Mask\s+Iface/);
  });

  it('bare arp -a on an empty table still prints nothing (BSD style, unaffected)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('arp -a');
    expect(out.trim()).toBe('');
  });
});

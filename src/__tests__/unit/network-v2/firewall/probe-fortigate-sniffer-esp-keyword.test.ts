/*
 * Probe: `diagnose sniffer packet wan1 "esp" 1` answered "unknown host 'esp'". libpcap's grammar reserves the
 * protocol names `esp`, `ah`, `igmp`, `igrp`, `pim`, `vrrp` and `sctp` as bare primitives (pcap-filter(7), same as
 * `ip proto esp`); the single filter parser in the repository (TcpdumpFilter, shared by Linux tcpdump and the
 * FortiGate sniffer) treated them as host names. The lab brings an IPsec tunnel up between two FortiGates and
 * sniffs the real ESP datagrams on the hub's WAN.
 *
 * Discriminated with git stash on src/network: 3 of 4 fall before the fix; the witness (`proto 50` already
 * selected the ESP datagrams) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function run(device: Cmd, ...lines: string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

async function tunnelEnd(fgt: Cmd, wan: string, peer: string): Promise<void> {
  await run(fgt,
    'config system interface', 'edit wan1', 'set mode static', `set ip ${wan} 255.255.255.0`,
    'set allowaccess ping', 'next', 'end',
    'config vpn ipsec phase1-interface', 'edit "t"', 'set interface "wan1"', 'set ike-version 2',
    `set remote-gw ${peer}`, 'set psksecret sekret123', 'set proposal aes256-sha256', 'set dhgrp 14', 'next', 'end',
    'config vpn ipsec phase2-interface', 'edit "t"', 'set phase1name "t"', 'set proposal aes256-sha256',
    'set src-subnet 0.0.0.0 0.0.0.0', 'set dst-subnet 0.0.0.0 0.0.0.0', 'next', 'end');
}

async function lab() {
  const hub = new FortiGate('firewall-fortinet', 'HUB', 0, 0);
  const spoke = new FortiGate('firewall-fortinet', 'SPOKE', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  for (const device of [hub, spoke, sw]) device.powerOn();
  new Cable('c0').connect(hub.getPort('wan1')!, sw.getPort('eth0')!);
  new Cable('c1').connect(spoke.getPort('wan1')!, sw.getPort('eth1')!);
  await tunnelEnd(hub, '203.0.113.1', '203.0.113.2');
  await tunnelEnd(spoke, '203.0.113.2', '203.0.113.1');
  await run(spoke,
    'config system interface', 'edit port1', 'set mode static', 'set ip 10.2.0.1 255.255.255.0',
    'set allowaccess ping', 'next', 'edit "t"', 'set allowaccess ping', 'next', 'end');
  await run(hub,
    'config router static', 'edit 1', 'set dst 10.2.0.0 255.255.255.0', 'set device "t"', 'next', 'end');
  await hub.executeCommand('diagnose vpn tunnel up t');
  await hub.executeCommand('execute ping 10.2.0.1');
  return hub;
}

const NONE = /^0 packets received by filter$/m;

const sniff = (hub: Cmd, filter: string) =>
  hub.executeCommand(`diagnose sniffer packet wan1 '${filter}' 4`);

describe('pcap-filter protocol names on the FortiGate sniffer', () => {
  it('witness: proto 50 already selects the ESP datagrams', async () => {
    const out = await sniff(await lab(), 'proto 50');
    expect(out).not.toMatch(NONE);
  });

  it('esp selects the same datagrams as proto 50', async () => {
    const out = await sniff(await lab(), 'esp');
    expect(out).not.toMatch(/Command fail|unknown host/);
    expect(out).not.toMatch(NONE);
  });

  it('not esp leaves the IKE exchange and drops the ESP datagrams', async () => {
    const hub = await lab();
    const withEsp = await sniff(hub, 'esp');
    const without = await sniff(hub, 'not esp');
    expect(without).not.toMatch(/Command fail|unknown host/);
    expect(without).not.toBe(withEsp);
  });

  it('ah is a protocol name too and matches nothing on an ESP-only tunnel', async () => {
    const out = await sniff(await lab(), 'ah');
    expect(out).not.toMatch(/Command fail|unknown host/);
    expect(out).toMatch(NONE);
  });
});

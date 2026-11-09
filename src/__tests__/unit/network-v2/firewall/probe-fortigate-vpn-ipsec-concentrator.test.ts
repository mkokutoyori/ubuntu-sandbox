/*
 * Probe: `config vpn ipsec concentrator` (FortiOS CLI Reference 7.4.12 p.2201: `member`, `name`, `src-check`)
 * did not exist ("unknown configuration path"). `set src-check disable` is documented as "Enable/disable
 * source IP check between concentrator members" ; the simulator already evaluates `src-check` per interface
 * (RFC 1122 §3.3.5 reverse-path check, `system interface` `src-check`) so this extends that mechanism rather
 * than inventing a new one: packets arriving on a member tunnel are exempt from the check specifically for
 * members of a concentrator declared with `src-check disable`.
 *
 * Measured by constructing the case the check exists to catch: a hub whose static route for a spoke's LAN
 * names a DIFFERENT tunnel than the one that spoke's own IPsec SA is bound to (an operator's routing mistake,
 * or asymmetric routing). Real traffic decapsulated off tunnel-A, carrying tunnel-A's source subnet, meets a
 * reverse-path lookup that resolves to tunnel-B, and src-check drops it before the hub forwards it on to
 * tunnel-B. A concentrator naming both tunnels with `src-check disable` lets it through.
 *
 * Discriminated with git stash on src/network: 3 of 5 fall before the fix; the witness (the same traffic is
 * dropped with no concentrator declared) and "src-check stays enforced outside the concentrator" pass either
 * way — the latter because an unrelated interface was never touched, before the fix or after.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function run(device: Cmd, ...lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of lines) out.push(await device.executeCommand(line));
  return out;
}

async function spokeSide(fgt: Cmd, wan: string, peer: string, lan: string): Promise<void> {
  await run(fgt,
    'config system interface', 'edit wan1', 'set mode static', `set ip ${wan} 255.255.255.0`,
    'set allowaccess ping', 'next',
    'edit port1', 'set mode static', `set ip ${lan}.1 255.255.255.0`, 'next', 'end',
    'config vpn ipsec phase1-interface', 'edit "t"', 'set interface "wan1"', 'set ike-version 2',
    `set remote-gw ${peer}`, 'set psksecret sekret123', 'set proposal aes256-sha256', 'set dhgrp 14', 'next', 'end',
    'config vpn ipsec phase2-interface', 'edit "t"', 'set phase1name "t"', 'set proposal aes256-sha256',
    `set src-subnet ${lan}.0 255.255.255.0`, 'set dst-subnet 0.0.0.0 0.0.0.0', 'next', 'end',
    'config router static', 'edit 1', 'set dst 10.0.0.0 255.0.0.0', 'set device "t"', 'next', 'end',
    'config firewall policy',
    'edit 1', 'set srcintf "port1"', 'set dstintf "t"', 'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set action accept', 'set schedule "always"', 'next',
    'edit 2', 'set srcintf "t"', 'set dstintf "port1"', 'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set action accept', 'set schedule "always"', 'next', 'end');
}

async function lab(concentrator: string[] = []) {
  const hub = new FortiGate('firewall-fortinet', 'HUB', 0, 0);
  const spokeA = new FortiGate('firewall-fortinet', 'A', 0, 0);
  const spokeB = new FortiGate('firewall-fortinet', 'B', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const pcA = new LinuxPC('linux-pc', 'PCA', 200, 0);
  const pcB = new LinuxPC('linux-pc', 'PCB', 400, 0);
  for (const device of [hub, spokeA, spokeB, sw, pcA, pcB]) device.powerOn();
  new Cable('c0').connect(hub.getPort('wan1')!, sw.getPort('eth0')!);
  new Cable('c1').connect(spokeA.getPort('wan1')!, sw.getPort('eth1')!);
  new Cable('c2').connect(spokeB.getPort('wan1')!, sw.getPort('eth2')!);
  new Cable('lan-a').connect(spokeA.getPort('port1')!, pcA.getPort('eth0')!);
  new Cable('lan-b').connect(spokeB.getPort('port1')!, pcB.getPort('eth0')!);

  const concentratorLines = concentrator.length === 0 ? [] : [
    'config vpn ipsec concentrator', 'edit 1', `set member "${concentrator[0]}" "${concentrator[1]}"`,
    'set src-check disable', 'next', 'end',
  ];
  await run(hub,
    'config system interface', 'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0',
    'set allowaccess ping', 'next', 'end',
    'config vpn ipsec phase1-interface',
    'edit "tun-a"', 'set interface "wan1"', 'set ike-version 2', 'set remote-gw 203.0.113.2',
    'set psksecret sekret123', 'set proposal aes256-sha256', 'set dhgrp 14', 'next',
    'edit "tun-b"', 'set interface "wan1"', 'set ike-version 2', 'set remote-gw 203.0.113.3',
    'set psksecret sekret123', 'set proposal aes256-sha256', 'set dhgrp 14', 'next', 'end',
    'config vpn ipsec phase2-interface',
    'edit "tun-a"', 'set phase1name "tun-a"', 'set proposal aes256-sha256',
    'set src-subnet 0.0.0.0 0.0.0.0', 'set dst-subnet 0.0.0.0 0.0.0.0', 'next',
    'edit "tun-b"', 'set phase1name "tun-b"', 'set proposal aes256-sha256',
    'set src-subnet 0.0.0.0 0.0.0.0', 'set dst-subnet 0.0.0.0 0.0.0.0', 'next', 'end',
    'config router static',
    'edit 1', 'set dst 10.1.0.0 255.255.255.0', 'set device "tun-b"', 'next',
    'edit 2', 'set dst 10.2.0.0 255.255.255.0', 'set device "tun-b"', 'next', 'end',
    ...concentratorLines,
    'config firewall policy',
    'edit 1', 'set srcintf "tun-a"', 'set dstintf "tun-b"', 'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set action accept', 'set schedule "always"', 'next',
    'edit 2', 'set srcintf "tun-b"', 'set dstintf "tun-a"', 'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set action accept', 'set schedule "always"', 'next', 'end');

  await spokeSide(spokeA, '203.0.113.2', '203.0.113.1', '10.1.0');
  await spokeSide(spokeB, '203.0.113.3', '203.0.113.1', '10.2.0');
  await run(pcA, 'ip link set eth0 up', 'ip addr add 10.1.0.10/24 dev eth0', 'ip route add default via 10.1.0.1');
  await run(pcB, 'ip link set eth0 up', 'ip addr add 10.2.0.10/24 dev eth0', 'ip route add default via 10.2.0.1');
  await hub.executeCommand('diagnose vpn tunnel up tun-a');
  await hub.executeCommand('diagnose vpn tunnel up tun-b');
  return { hub, pcA, pcB };
}

describe('vpn ipsec concentrator', () => {
  it('witness: with no concentrator, src-check drops traffic whose reverse route disagrees', async () => {
    const { pcA } = await lab();
    const out = await pcA.executeCommand('ping -c 2 10.2.0.10');
    expect(out).toContain('100% packet loss');
  });

  it('accepts the configuration and names the missing brick for an unknown member', async () => {
    const { hub } = await lab();
    const out = await run(hub,
      'config vpn ipsec concentrator', 'edit 1', 'set member "tun-a" "nope"', 'set src-check disable', 'next', 'end');
    expect(out.join('\n')).toMatch(/does not exist/);
  });

  it('a declared concentrator with src-check disable lets the asymmetric traffic through', async () => {
    const { pcA } = await lab(['tun-a', 'tun-b']);
    const out = await pcA.executeCommand('ping -c 2 10.2.0.10');
    expect(out).toContain('2 received');
  });

  it('src-check stays enforced on an interface outside the concentrator', async () => {
    const { hub } = await lab(['tun-a', 'tun-b']);
    const shown = await hub.executeCommand('show system interface wan1');
    expect(shown).not.toContain('set src-check disable');
  });

  it('a concentrator needs at least two members', async () => {
    const { hub } = await lab();
    const out = await run(hub,
      'config vpn ipsec concentrator', 'edit 1', 'set member "tun-a"', 'next', 'end');
    expect(out.join('\n')).toMatch(/at least two member tunnels/);
  });
});

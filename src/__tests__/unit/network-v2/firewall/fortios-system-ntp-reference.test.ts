/**
 * `config system ntp` after the FortiOS CLI Reference (official_docs/
 * forti-cli-ref-767.txt, 7.6.7, and -7412.txt, 7.4.12): the global attributes
 * authentication, interface, key, key-id, key-type, ntpsync, server-mode,
 * source-ip, source-ip6, syncinterval and type, and per `ntpserver` entry
 * authentication, interface, interface-select-method, ip-type, key, key-id,
 * key-type, ntpv3, server and vrf-select. Every criterion the engine can
 * evaluate decides something on the wire: the NTP version byte, the source
 * address, the polling interval, who may query the FortiGate and with which
 * key, and which servers are used at all. The previous schema carried a
 * `source-ip-interface` attribute that the reference does not have and had
 * none of the others.
 *
 * Measured against HEAD (git worktree): see the count in the commit message.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock, converge } from '../../../support/ntpTime';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = installVirtualClock();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function run(device: { executeCommand(line: string): Promise<string> }, lines: string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

interface Seen { version: number; source: string; destination: string; time: number }

async function lab(ntpLines: string[], options: { masterKey?: boolean } = {}) {
  const bus = new EventBus();
  const reference = new CiscoRouter('R1');
  const fortigate = new FortiGate('firewall-fortinet', 'FGT');
  const sw = new GenericSwitch('switch-generic', 'SW');
  const linux = new LinuxPC('L1');
  const client = new CiscoRouter('R2');
  for (const device of [reference, fortigate, sw, linux, client]) device.setEventBus(bus);
  const cables = ['a', 'b', 'c', 'd'].map((name) => { const cable = new Cable(name); cable.setEventBus(bus); return cable; });
  cables[0].connect(reference.getPort('GigabitEthernet0/0')!, sw.getPorts()[0]);
  cables[1].connect(fortigate.getPorts()[1], sw.getPorts()[1]);
  cables[2].connect(linux.getPort('eth0')!, sw.getPorts()[2]);
  cables[3].connect(client.getPort('GigabitEthernet0/0')!, sw.getPorts()[3]);
  const seen: Seen[] = [];
  bus.subscribe('cable.frame.delivered', (event) => {
    const packet = event.payload.frame.payload as unknown as {
      protocol?: number; sourceIP?: { toString(): string }; destinationIP?: { toString(): string };
      payload?: { destinationPort?: number; payload?: Uint8Array };
    } | undefined;
    const body = packet?.payload?.payload;
    if (packet?.protocol === 17 && packet.payload?.destinationPort === 123 && body instanceof Uint8Array && (body[0] & 7) === 3) {
      seen.push({ version: (body[0] >> 3) & 7, source: packet.sourceIP!.toString(), destination: packet.destinationIP!.toString(), time: Date.now() });
    }
  });
  await run(reference, ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown',
    'exit', 'ntp master 2', ...(options.masterKey ? ['ntp authentication-key 1 md5 SECRET', 'ntp trusted-key 1'] : []), 'end']);
  await run(fortigate, ['config system interface', 'edit port2', 'set mode static', 'set ip 10.0.0.3 255.255.255.0', 'next',
    'edit port3', 'set mode static', 'set ip 10.0.9.3 255.255.255.0', 'next', 'end', ...ntpLines]);
  await run(linux, ['ip addr add 10.0.0.5/24 dev eth0']);
  await run(client, ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.6 255.255.255.0', 'no shutdown', 'exit', 'end']);
  converge(clock, 400_000);
  return { fortigate, linux, client, seen, reference };
}

const server = (...lines: string[]): string[] => ['config system ntp', 'set ntpsync enable', 'set type custom', ...lines,
  'config ntpserver', 'edit 1', 'set server "10.0.0.1"', 'next', 'end', 'end'];
const entry = (...lines: string[]): string[] => ['config system ntp', 'set ntpsync enable', 'set type custom',
  'config ntpserver', 'edit 1', 'set server "10.0.0.1"', ...lines, 'next', 'end', 'end'];

describe('global attributes of the reference', () => {
  it('witness: a custom server synchronises the FortiGate', async () => {
    const { fortigate } = await lab(server());
    expect(await fortigate.executeCommand('diagnose sys ntp status')).toContain('synchronized: yes');
  });

  it('the reference attributes are accepted, rendered back, and source-ip-interface is gone', async () => {
    const { fortigate } = await lab(['config system ntp', 'set server-mode enable', 'set interface "port2"', 'set authentication enable',
      'set key-id 7', 'set key-type SHA256', 'set syncinterval 30', 'end']);
    const shown = await fortigate.executeCommand('show full-configuration system ntp');
    for (const line of ['set server-mode enable', 'set interface "port2"', 'set authentication enable', 'set key-id 7', 'set key-type SHA256', 'set syncinterval 30']) {
      expect(shown).toContain(line);
    }
    expect(await fortigate.executeCommand('config system ntp\nset source-ip-interface "port2"')).toMatch(/Command fail|invalid|Unknown|Invalid/i);
  });

  it('[fails before] the key type and the sync interval keep the reference ranges', async () => {
    const { fortigate } = await lab([]);
    await run(fortigate, ['config system ntp']);
    expect(await fortigate.executeCommand('set key-type SHA512')).toMatch(/Command fail|invalid|Invalid|Unknown/i);
    expect(await fortigate.executeCommand('set syncinterval 1441')).toMatch(/Command fail|invalid|Invalid|range|out of/i);
    await fortigate.executeCommand('abort');
  });
});

describe('server-mode and interface', () => {
  it('[fails before] with server-mode on the listed interface a client synchronises from the FortiGate', async () => {
    const { client } = await lab([...server('set server-mode enable', 'set interface "port2"')]);
    await run(client, ['configure terminal', 'ntp server 10.0.0.3', 'end']);
    converge(clock, 400_000);
    expect(await client.executeCommand('show ntp status')).toContain('reference is 10.0.0.3');
  });

  it('[fails before] without server-mode the FortiGate answers nobody', async () => {
    const { client } = await lab([...server('set interface "port2"')]);
    await run(client, ['configure terminal', 'ntp server 10.0.0.3', 'end']);
    converge(clock, 400_000);
    expect(await client.executeCommand('show ntp status')).toContain('Clock is unsynchronized');
  });

  it('[fails before] server-mode on another interface does not answer on this one', async () => {
    const { client } = await lab([...server('set server-mode enable', 'set interface "port3"')]);
    await run(client, ['configure terminal', 'ntp server 10.0.0.3', 'end']);
    converge(clock, 400_000);
    expect(await client.executeCommand('show ntp status')).toContain('Clock is unsynchronized');
  });
});

describe('authentication', () => {
  it('[fails before] with authentication the FortiGate only serves clients that sign with the key', async () => {
    const { client } = await lab(server('set server-mode enable', 'set interface "port2"', 'set authentication enable',
      'set key "SECRET"', 'set key-id 5', 'set key-type MD5'));
    await run(client, ['configure terminal', 'ntp server 10.0.0.3', 'end']);
    converge(clock, 400_000);
    expect(await client.executeCommand('show ntp status')).toContain('Clock is unsynchronized');
    await run(client, ['configure terminal', 'no ntp server 10.0.0.3', 'ntp authentication-key 5 md5 SECRET', 'ntp trusted-key 5',
      'ntp authenticate', 'ntp server 10.0.0.3 key 5', 'end']);
    converge(clock, 400_000);
    expect(await client.executeCommand('show ntp status')).toContain('reference is 10.0.0.3');
  });

  it('[fails before] a ntpserver entry with a key signs its requests and the answer must verify', async () => {
    const { fortigate, reference } = await lab(entry('set authentication enable', 'set key "SECRET"', 'set key-id 1', 'set key-type MD5'), { masterKey: true });
    expect(await fortigate.executeCommand('diagnose sys ntp status')).toContain('synchronized: yes');
    expect(reference.getNtpAgent().getCounters().authOk).toBeGreaterThan(0);
  });

  it('[fails before] a wrong key leaves the FortiGate unsynchronised', async () => {
    const { fortigate } = await lab(entry('set authentication enable', 'set key "WRONG"', 'set key-id 1', 'set key-type MD5'), { masterKey: true });
    expect(await fortigate.executeCommand('diagnose sys ntp status')).toContain('synchronized: no');
  });
});

describe('what an ntpserver entry decides on the wire', () => {
  it('[fails before] ntpv3 enable sends version 3, the default sends version 4', async () => {
    const v3 = await lab(entry('set ntpv3 enable'));
    expect(v3.seen.length).toBeGreaterThan(0);
    expect(v3.seen.every((s) => s.version === 3)).toBe(true);
  });

  it('witness: by default the requests are version 4', async () => {
    const v4 = await lab(server());
    expect(v4.seen.length).toBeGreaterThan(0);
    expect(v4.seen.every((s) => s.version === 4)).toBe(true);
  });

  it('[fails before] source-ip decides the source address of the requests', async () => {
    const { seen } = await lab(['config system ntp', 'set ntpsync enable', 'set type custom', 'set source-ip 10.0.9.3',
      'config ntpserver', 'edit 1', 'set server "10.0.0.1"', 'next', 'end', 'end']);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.source === '10.0.9.3')).toBe(true);
  });

  it('[fails before] interface-select-method specify with an interface sources the request from it', async () => {
    const { seen } = await lab(entry('set interface-select-method specify', 'set interface "port3"'));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.source === '10.0.9.3')).toBe(true);
  });

  it('[fails before] syncinterval sets the polling interval in minutes', async () => {
    const fast = await lab(['config system ntp', 'set ntpsync enable', 'set type custom', 'set syncinterval 2',
      'config ntpserver', 'edit 1', 'set server "10.0.0.1"', 'next', 'end', 'end']);
    const slow = await lab(['config system ntp', 'set ntpsync enable', 'set type custom', 'set syncinterval 30',
      'config ntpserver', 'edit 1', 'set server "10.0.0.1"', 'next', 'end', 'end']);
    expect(fast.seen.length).toBeGreaterThan(slow.seen.length);
  });

  it('[fails before] ip-type IPv6 makes an IPv4 literal unusable', async () => {
    const { fortigate, seen } = await lab(entry('set ip-type IPv6'));
    expect(seen).toHaveLength(0);
    expect(await fortigate.executeCommand('diagnose sys ntp status')).toContain('synchronized: no');
  });

  it('[fails before] vrf-select on a VRF that does not exist leaves the server unreachable', async () => {
    const { seen } = await lab(entry('set vrf-select 5'));
    expect(seen).toHaveLength(0);
  });
});

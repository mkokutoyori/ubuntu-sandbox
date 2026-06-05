import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function buildLab() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 200, 0);
  const h1 = new LinuxPC('linux-pc', 'H1', -100, 0);
  const h2 = new LinuxPC('linux-pc', 'H2', 300, 0);
  new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('c').connect(r2.getPort('GigabitEthernet0/0')!, h2.getPort('eth0')!);
  await run(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.12.12.1 255.255.255.252', 'no shutdown', 'exit',
    'ip route 10.0.2.0 255.255.255.0 10.12.12.2', 'end']);
  await run(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.12.12.2 255.255.255.252', 'no shutdown', 'exit',
    'ip route 10.0.1.0 255.255.255.0 10.12.12.1', 'end']);
  await run(h1, ['ip link set eth0 up', 'ip addr add 10.0.1.10/24 dev eth0', 'ip route add default via 10.0.1.1']);
  await run(h2, ['ip link set eth0 up', 'ip addr add 10.0.2.10/24 dev eth0', 'ip route add default via 10.0.2.1']);
  return { r1, r2, h1, h2 };
}

beforeEach(() => { Logger.reset(); });

describe('ACL ICMP message-type matching', () => {
  it('permits the matching ICMP type and drops a non-matching one', async () => {
    const { r2, h1 } = await buildLab();
    expect(await h1.executeCommand('ping -c 1 10.0.2.10')).toContain('0% packet loss');

    await run(r2, ['configure terminal',
      'ip access-list extended ECHO-REPLY-ONLY',
      'permit icmp any any echo-reply',
      'permit ip any 10.12.12.0 0.0.0.3',
      'exit',
      'interface GigabitEthernet0/1', 'ip access-group ECHO-REPLY-ONLY in', 'exit', 'end']);

    const dropped = await h1.executeCommand('ping -c 2 10.0.2.10');
    expect(dropped).toContain('100% packet loss');

    await run(r2, ['configure terminal',
      'interface GigabitEthernet0/1', 'no ip access-group ECHO-REPLY-ONLY in', 'exit',
      'ip access-list extended ALLOW-ECHO',
      'permit icmp any any echo',
      'exit',
      'interface GigabitEthernet0/1', 'ip access-group ALLOW-ECHO in', 'exit', 'end']);

    const allowed = await h1.executeCommand('ping -c 2 10.0.2.10');
    expect(allowed).toContain('0% packet loss');

    const counters = await r2.executeCommand('show ip access-lists ALLOW-ECHO');
    expect(counters).toMatch(/permit icmp any any echo \([1-9]/);
  });

  it('deny of a specific ICMP type does not block other types', async () => {
    const { r2, h1 } = await buildLab();
    await run(r2, ['configure terminal',
      'ip access-list extended NO-UNREACH',
      'deny icmp any any unreachable',
      'permit ip any any',
      'exit',
      'interface GigabitEthernet0/1', 'ip access-group NO-UNREACH in', 'exit', 'end']);

    const allowed = await h1.executeCommand('ping -c 2 10.0.2.10');
    expect(allowed).toContain('0% packet loss');
  });
});

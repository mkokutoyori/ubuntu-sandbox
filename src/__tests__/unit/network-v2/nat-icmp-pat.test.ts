import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

describe('NAT PAT — ICMP query return path', () => {
  it('an inside host can ping an outside host through PAT overload', async () => {
    const r = new CiscoRouter('R', 0, 0);
    const inside = new LinuxPC('linux-pc', 'IN', -100, 0);
    const isp = new LinuxServer('linux-server', 'ISP', 100, 0);
    new Cable('a').connect(inside.getPort('eth0')!, r.getPort('GigabitEthernet0/0')!);
    new Cable('b').connect(r.getPort('GigabitEthernet0/1')!, isp.getPort('eth0')!);

    await run(r, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.1.1.1 255.255.255.0', 'ip nat inside', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 203.0.113.1 255.255.255.0', 'ip nat outside', 'no shutdown', 'exit',
      'access-list 1 permit 10.1.1.0 0.0.0.255',
      'ip nat inside source list 1 interface GigabitEthernet0/1 overload', 'end']);
    await run(inside, ['ip link set eth0 up', 'ip addr add 10.1.1.10/24 dev eth0', 'ip route add default via 10.1.1.1']);
    await run(isp, ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0', 'ip route add default via 203.0.113.1']);

    const ping = await inside.executeCommand('ping -c 2 203.0.113.10');
    expect(ping).toContain('0% packet loss');

    const xlate = await r.executeCommand('show ip nat translations');
    expect(xlate).toMatch(/icmp 203\.0\.113\.1:\d+\s+10\.1\.1\.10:[1-9]/);
  });
});

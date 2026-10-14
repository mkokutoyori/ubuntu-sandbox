/**
 * One Cisco reference (`ntp master 2`) and one client of each other platform
 * on the same segment: Huawei VRP, FortiGate, Windows (w32tm) and Linux
 * (chronyd). Every client must reach stratum 3 over real UDP/123 frames and
 * its own status command must say so.
 *
 * Measured against HEAD (git worktree): the FortiGate case falls (its
 * replies from UDP/123 never reached the NTP agent, so `diagnose sys ntp
 * status` stayed "Unreachable" although the server answered); the Huawei,
 * Windows and Linux cases pass either way and are non-regression witnesses
 * of the shared agent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock, converge } from '../../support/ntpTime';

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

async function lab() {
  const reference = new CiscoRouter('R1');
  const huawei = new HuaweiRouter('R2');
  const fortigate = new FortiGate('firewall-fortinet', 'FGT');
  const windows = new WindowsPC('windows-pc', 'W1');
  windows.setCurrentUser('Administrator');
  const linux = new LinuxPC('L1');
  const sw = new GenericSwitch('switch-generic', 'SW');
  const ports = [reference.getPort('GigabitEthernet0/0')!, huawei.getPorts()[0], fortigate.getPorts()[1], windows.getPorts()[0], linux.getPort('eth0')!];
  ports.forEach((port, index) => new Cable(`c${index}`).connect(port, sw.getPorts()[index]));
  await run(reference, ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
    'no shutdown', 'exit', 'ntp master 2', 'end']);
  await run(huawei, ['system-view', 'interface GigabitEthernet0/0/0', 'ip address 10.0.0.2 255.255.255.0', 'undo shutdown',
    'quit', 'ntp-service unicast-server 10.0.0.1', 'return']);
  await run(fortigate, ['config system interface', 'edit port2', 'set mode static', 'set ip 10.0.0.3 255.255.255.0', 'next', 'end',
    'config system ntp', 'set ntpsync enable', 'set type custom', 'config ntpserver', 'edit 1', 'set server 10.0.0.1',
    'next', 'end', 'end']);
  await run(windows, ['netsh interface ip set address "Ethernet0" static 10.0.0.4 255.255.255.0',
    'w32tm /config /syncfromflags:manual /manualpeerlist:"10.0.0.1" /update']);
  await run(linux, ['ip addr add 10.0.0.5/24 dev eth0',
    "printf 'server 10.0.0.1 iburst\\nmakestep 1000 3\\n' | sudo tee /etc/chrony/chrony.conf", 'sudo systemctl restart chrony']);
  converge(clock, 400_000);
  return { huawei, fortigate, windows, linux };
}

describe('every platform follows the Cisco reference over the wire', () => {
  it('Huawei VRP reports a synchronised clock at stratum 3', async () => {
    const { huawei } = await lab();
    const status = await huawei.executeCommand('display ntp-service status');
    expect(status).toContain('Clock status: synchronized');
    expect(status).toContain('Clock stratum: 3');
  });

  it('[fails before] FortiGate reports synchronized: yes and the server reachable at stratum 2', async () => {
    const { fortigate } = await lab();
    const status = await fortigate.executeCommand('diagnose sys ntp status');
    expect(status).toContain('synchronized: yes');
    expect(status).toMatch(/ipv4 server\(10\.0\.0\.1\) -- reachable/);
    expect(status).toContain('stratum=2');
  });

  it('Windows w32tm reports stratum 3', async () => {
    const { windows } = await lab();
    expect(await windows.executeCommand('w32tm /query /status')).toContain('Stratum: 3');
  });

  it('Linux chronyd selects the reference', async () => {
    const { linux } = await lab();
    expect(await linux.executeCommand('chronyc sources')).toMatch(/\^\* 10\.0\.0\.1 +2 /);
  });
});

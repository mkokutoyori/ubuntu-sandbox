/**
 * DHCP option 42 (RFC 2132 §8.3, NTP servers) on the wire. A Windows Server
 * DHCP scope serves it with `Set-DhcpServerv4OptionValue -OptionId 42`; the
 * server sends it only to a client whose parameter request list asks for it
 * (RFC 2131 §4.3.1), so an ISC-style Linux client receives it and a Windows
 * client, whose list does not contain 42, does not.
 *
 * On the Linux client the lease reaches chrony the way the Debian package
 * does it: dhclient publishes /run/chrony-dhcp/<iface>.sources, the default
 * chrony.conf has `sourcedir /run/chrony-dhcp`, and the daemon follows the
 * server.
 *
 * Measured against the previous tree (git worktree of HEAD): 3 of the 4
 * option cases fall (option 42 was refused by the Windows scope and ignored
 * by the client), and the chrony case falls; the witness (the Windows client
 * leases an address) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock, converge } from '../../support/ntpTime';
import { WindowsDhcpServerRole } from '@/network/devices/windows/server/dhcp/WindowsDhcpServerRole';
import type { EndHost } from '@/network/devices/EndHost';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = installVirtualClock();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function lab() {
  const server = new LinuxPC('linux-pc', 'DHCPHOST');
  const linux = new LinuxPC('linux-pc', 'LINUXC');
  const windows = new WindowsPC('windows-pc', 'WINC');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(linux.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(windows.getPorts()[0], sw.getPorts()[2]);
  server.getPorts()[0].configureIP(new IPAddress('192.168.70.10'), new SubnetMask('255.255.255.0'));
  const role = new WindowsDhcpServerRole(server as unknown as EndHost);
  role.start();
  role.addScope('LAN', '192.168.70.100', '192.168.70.200', '255.255.255.0');
  return { role, linux, windows, server };
}

describe('DHCP option 42 from a Windows Server scope', () => {
  it('witness: a Windows client leases an address from the scope', () => {
    const { windows } = lab();
    windows.getDHCPClient().requestLease(windows.getPorts()[0].getName(), { verbose: true });
    expect(windows.getDHCPClient().getState(windows.getPorts()[0].getName()).state).toBe('BOUND');
  });

  it('[fails before] the scope accepts option 42 and reads it back with its name', () => {
    const { role } = lab();
    expect(role.setOptionValue('LAN', 42, ['192.168.70.10']).ok).toBe(true);
    expect(role.listOptionValues('LAN').find((o) => o.optionId === 42)).toMatchObject({ name: 'NTP Servers', values: ['192.168.70.10'] });
  });

  it('[fails before] a client that requests option 42 receives the servers', () => {
    const { role, linux } = lab();
    role.setOptionValue('LAN', 42, ['192.168.70.10', '192.168.70.11']);
    linux.getDHCPClient().requestLease('eth0', { verbose: true });
    expect(linux.getDHCPClient().getState('eth0').lease?.ntpServers).toEqual(['192.168.70.10', '192.168.70.11']);
  });

  it('[fails before] a Windows client does not request option 42 and is not sent it', () => {
    const { role, windows } = lab();
    role.setOptionValue('LAN', 42, ['192.168.70.10']);
    const name = windows.getPorts()[0].getName();
    windows.getDHCPClient().requestLease(name, { verbose: true });
    const lease = windows.getDHCPClient().getState(name).lease;
    expect(lease?.ipAddress).toMatch(/^192\.168\.70\./);
    expect(lease?.ntpServers).toEqual([]);
  });

  it('[fails before] chrony on the Linux client follows the server learned by DHCP, through sourcedir', async () => {
    const { role, linux, server } = lab();
    role.setOptionValue('LAN', 42, ['192.168.70.10']);
    await server.executeCommand("printf 'local stratum 5\\nallow\\n' | sudo tee /etc/chrony/chrony.conf");
    await server.executeCommand('sudo systemctl restart chrony');
    await linux.executeCommand('sudo systemctl restart chrony');
    linux.getDHCPClient().requestLease('eth0', { verbose: true });
    converge(clock, 200_000);
    expect(await linux.executeCommand('cat /run/chrony-dhcp/eth0.sources')).toBe('server 192.168.70.10 iburst');
    expect(await linux.executeCommand('chronyc sources')).toMatch(/\^\* 192\.168\.70\.10 +5 /);
  });
});

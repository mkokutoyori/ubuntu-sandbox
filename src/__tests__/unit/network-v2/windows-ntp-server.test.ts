/**
 * Windows as an NTP server for Linux and Cisco clients, over real frames.
 * W32Time ships with the NtpServer provider disabled (TimeProviders\NtpServer
 * Enabled = 0), so a Windows machine that is synchronised still stays silent
 * until the operator enables the provider and applies it with
 * `w32tm /config /update`. Once enabled it serves the stratum it follows plus
 * one. Windows has no NTS: nothing here negotiates it.
 *
 * Measured against HEAD before the NTS integration (git worktree): all 4
 * cases pass. This is a non-regression pin of the cross-platform path, not a
 * defect fix: the NtpServer gate and the serving already existed, and the
 * NTS changes to NtpAgent (extension fields, chrony profile) must leave them
 * unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

const SERVER_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\W32Time\\TimeProviders\\NtpServer';

async function configureRouter(router: CiscoRouter, address: string, extra: string[]): Promise<void> {
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', `ip address ${address} 255.255.255.0`,
    'no shutdown', 'exit', ...extra, 'end']) await router.executeCommand(c);
}

async function lab(enableProvider: boolean) {
  const win = new WindowsPC('windows-pc', 'W1');
  win.setCurrentUser('Administrator');
  const linux = new LinuxPC('L1');
  const cisco = new CiscoRouter('R1');
  const reference = new CiscoRouter('R2');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('a').connect(win.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(linux.getPort('eth0')!, sw.getPorts()[1]);
  new Cable('c').connect(cisco.getPort('GigabitEthernet0/0')!, sw.getPorts()[2]);
  new Cable('d').connect(reference.getPort('GigabitEthernet0/0')!, sw.getPorts()[3]);
  await win.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.2 255.255.255.0');
  await linux.executeCommand('ip addr add 10.0.0.3/24 dev eth0');
  await configureRouter(reference, '10.0.0.1', ['ntp master 2']);
  await configureRouter(cisco, '10.0.0.4', ['ntp server 10.0.0.2']);
  await win.executeCommand('w32tm /config /syncfromflags:manual /manualpeerlist:"10.0.0.1" /update');
  converge(clock, 100_000);
  if (enableProvider) {
    await win.executeCommand(`reg add ${SERVER_KEY} /v Enabled /t REG_DWORD /d 1 /f`);
    await win.executeCommand('w32tm /config /update');
  }
  await linux.executeCommand("printf 'server 10.0.0.2 iburst\\nmakestep 1000 3\\n' | sudo tee /etc/chrony/chrony.conf");
  await linux.executeCommand('sudo systemctl restart chrony');
  converge(clock, 200_000);
  return { win, linux, cisco };
}

describe('Windows serves time only once the NtpServer provider is enabled', () => {
  it('witness: Windows itself follows the Cisco reference at stratum 3', async () => {
    const { win } = await lab(false);
    expect(await win.executeCommand('w32tm /query /status')).toContain('Stratum: 3');
  });

  it('with the provider disabled the Linux client never hears an answer', async () => {
    const { linux } = await lab(false);
    expect(await linux.executeCommand('chronyc sources')).toMatch(/\^\? 10\.0\.0\.2 +0 /);
  });

  it('with the provider enabled chrony selects Windows at stratum 3', async () => {
    const { linux } = await lab(true);
    expect(await linux.executeCommand('chronyc sources')).toMatch(/\^\* 10\.0\.0\.2 +3 /);
  });

  it('with the provider enabled the Cisco client reaches Windows', async () => {
    const { cisco } = await lab(true);
    const output = await cisco.executeCommand('show ntp associations');
    expect(output).toMatch(/10\.0\.0\.2 +10\.0\.0\.2 +3 /);
    expect(output).toMatch(/10\.0\.0\.2 +10\.0\.0\.2 +3 +\d+ +\d+ +\d+/);
  });
});

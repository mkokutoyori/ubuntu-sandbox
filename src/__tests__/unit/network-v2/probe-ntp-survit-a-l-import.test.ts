/**
 * A saved lab keeps its NTP configuration AND its machines act on it when the lab is opened again.
 *
 * Measured on the NTP lab (srv-ext in chrony `local stratum 4`, two chrony peers, a router, two switches, a domain controller, two PCs,
 * a log server), exported with every machine synchronised and imported into a fresh session:
 *  - every Linux machine kept `/etc/chrony/chrony.conf` and `systemctl is-active chrony` said `active`, yet `chronyc sources` was empty
 *    and the daemon served nobody: it had started on the Debian default file BEFORE the saved one was written back, and nothing told it to
 *    read the file again;
 *  - the Windows machines kept `W32Time\\Parameters\\NtpServer` in the registry and the service showed RUNNING, yet `w32tm /query /status`
 *    said "Local CMOS Clock, not synchronized": the registry was restored after the service had read it;
 *  - the Huawei switch lost its `ntp-service unicast-server` lines: `display current-configuration` did not render them, so the exported
 *    configuration text had nothing to replay (the Huawei router, and the Cisco machines, did render them);
 *  - the routers that polled such servers found them silent and backed off to a 512 s poll.
 * Thirty virtual minutes later nothing was synchronised, and a clock skewed by hand stayed skewed.
 *
 * A restored machine now starts its time daemon from the files it was given, as a booted machine does; the Windows time service reads the
 * restored registry; the Huawei switch renders its NTP configuration like the router does.
 *
 * Discriminated against the previous state (`git stash` of src/network and src/store, the probe kept): 5 of the 6 cases fall. The one that
 * passes either way is the WITNESS, built in the same lab before the export: it proves the lab synchronises, so a failure after the import
 * accuses the import and not the setup.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { buildConnection, type Connection } from '@/store/networkStore';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import type { Equipment } from '@/network/equipment/Equipment';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock, converge } from '../../support/ntpTime';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = installVirtualClock();
  EquipmentRegistry.resetInstance();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const SERVER_CONF = ['local stratum 4', 'makestep 1 3', 'allow'];
const CLIENT_CONF = ['server 192.168.100.5 iburst', 'makestep 1 3'];

const tee = (lines: readonly string[]): string =>
  `printf '${lines.join('\\n')}\\n' | sudo tee /etc/chrony/chrony.conf`;

interface Lab {
  readonly server: LinuxServer;
  readonly linux: LinuxPC;
  readonly windows: WindowsPC;
  readonly devices: Map<string, Equipment>;
  readonly connections: Connection[];
}

async function build(): Promise<Lab> {
  const server = new LinuxServer('linux-server', 'SRV');
  const linux = new LinuxPC('linux-pc', 'LNX');
  const windows = new WindowsPC('windows-pc', 'WIN');
  windows.setCurrentUser('Administrator');
  const connections = [
    buildConnection(server, 'eth0', linux, 'eth0', 'ethernet'),
    buildConnection(server, 'eth1', windows, windows.getPorts()[0].getName(), 'ethernet'),
  ].filter((c): c is Connection => c !== null);
  await server.executeCommand('ip addr add 192.168.100.5/24 dev eth0');
  await server.executeCommand('ip addr add 192.168.101.5/24 dev eth1');
  await linux.executeCommand('ip addr add 192.168.100.9/24 dev eth0');
  await windows.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.101.9 255.255.255.0');
  await server.executeCommand(tee(SERVER_CONF));
  await server.executeCommand('sudo systemctl restart chrony');
  await linux.executeCommand(tee(CLIENT_CONF));
  await linux.executeCommand('sudo systemctl restart chrony');
  await windows.executeCommand('w32tm /config /manualpeerlist:"192.168.101.5,0x8" /syncfromflags:manual /reliable:YES /update');
  const devices = new Map<string, Equipment>([server, linux, windows].map((d) => [d.getId(), d as Equipment]));
  return { server, linux, windows, devices, connections };
}

async function reopened(lab: Lab): Promise<{ server: LinuxServer; linux: LinuxPC; windows: WindowsPC }> {
  const saved = JSON.parse(JSON.stringify(exportTopology('lab', lab.devices, lab.connections)));
  EquipmentRegistry.resetInstance();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  clock = installVirtualClock();
  const imported = await importTopology(saved);
  const byName = new Map([...imported.deviceInstances.values()].map((d) => [d.getName(), d]));
  const windows = byName.get('WIN') as WindowsPC;
  windows.setCurrentUser('Administrator');
  converge(clock, 1_200_000);
  return { server: byName.get('SRV') as LinuxServer, linux: byName.get('LNX') as LinuxPC, windows };
}

describe('NTP survives a save and a reopening', () => {
  it('WITNESS: the lab synchronises before it is saved', async () => {
    const lab = await build();
    converge(clock, 1_200_000);
    expect(await lab.linux.executeCommand('chronyc tracking')).toContain('Reference ID    : C0A86405');
    expect(await lab.windows.executeCommand('w32tm /query /status')).toContain('Source: 192.168.101.5,0x8');
  });

  it('a reopened chrony server still serves the time', async () => {
    const lab = await build();
    converge(clock, 1_200_000);
    const { server } = await reopened(lab);
    const tracking = await server.executeCommand('chronyc tracking');
    expect(tracking).toContain('Stratum         : 4');
  });

  it('a reopened chrony client is synchronised to the reopened server', async () => {
    const lab = await build();
    converge(clock, 1_200_000);
    const { linux } = await reopened(lab);
    const tracking = await linux.executeCommand('chronyc tracking');
    expect(tracking).toContain('Reference ID    : C0A86405');
    expect(tracking).toContain('Stratum         : 5');
  });

  it('a reopened chrony client lists its source as selected', async () => {
    const lab = await build();
    converge(clock, 1_200_000);
    const { linux } = await reopened(lab);
    expect(await linux.executeCommand('chronyc sources')).toMatch(/\^\* 192\.168\.100\.5/);
  });

  it('a reopened Windows machine follows the time source stored in its registry', async () => {
    const lab = await build();
    converge(clock, 1_200_000);
    const { windows } = await reopened(lab);
    const status = await windows.executeCommand('w32tm /query /status');
    expect(status).toContain('Source: 192.168.101.5,0x8');
    expect(status).toContain('Leap Indicator: 0');
  });

  it('a Huawei switch renders its NTP configuration so that a saved lab can replay it', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW');
    for (const line of ['system-view', 'ntp-service unicast-server 192.168.100.5', 'ntp-service unicast-server 192.168.100.6 preference', 'return']) {
      await sw.executeCommand(line);
    }
    const rendered = await sw.executeCommand('display current-configuration');
    expect(rendered).toContain('ntp-service unicast-server 192.168.100.5');
    expect(rendered).toContain('ntp-service unicast-server 192.168.100.6 preference');
  });
});

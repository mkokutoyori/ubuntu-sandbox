/**
 * chronyd time smoothing: the `smoothtime` directive builds a smoother
 * (smooth.c, compared line by line in chrony-smooth-oracle.test.ts) whose
 * offset is added to the receive and transmit timestamps and to the
 * reference time of every server reply, with the reference ID SMOO; a clock
 * step resets it; `chronyc smoothing` and `chronyc smoothtime` read and
 * drive it.
 *
 * Measured against the previous agent (git worktree of HEAD): 3 of the 5
 * cases fall and 2 pass. The 2 are witnesses: without `smoothtime` the
 * daemon answers 505 before and after, and an invalid `smoothtime 400` line
 * leaves smoothing disabled (505) before, because nothing was ever
 * enabled, and after, because the line is refused like any unknown
 * directive.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import type { NtpAgent } from '@/network/ntp/NtpAgent';
import { installVirtualClock, converge } from '../../support/ntpTime';

let clock: VirtualTimeScheduler;
let serie = 0;

beforeEach(() => {
  clock = installVirtualClock();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const agentOf = (device: unknown): NtpAgent => (device as { getNtpAgent(): NtpAgent }).getNtpAgent();

async function write(pc: LinuxPC, path: string, text: string): Promise<void> {
  await pc.executeCommand(`printf '${text.replace(/\n/g, '\\n')}' | sudo tee ${path}`);
}

async function lab(serverConf: string) {
  const tag = ++serie;
  const sw = new CiscoSwitch('switch-cisco', `W${tag}`, 24, 0, 0);
  const router = new CiscoRouter(`R${tag}`);
  const server = new LinuxPC(`S${tag}`);
  const client = new LinuxPC(`C${tag}`);
  new Cable(`a${tag}`).connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable(`b${tag}`).connect(server.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable(`c${tag}`).connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);
  for (const command of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'ntp master 2', 'end']) {
    await router.executeCommand(command);
  }
  await server.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  await client.executeCommand('ip addr add 10.0.0.3/24 dev eth0');
  await write(server, '/etc/chrony/chrony.conf', serverConf);
  await write(client, '/etc/chrony/chrony.conf', 'server 10.0.0.2 minpoll 4 maxpoll 4\nmakestep 1000 3\n');
  await server.executeCommand('sudo systemctl restart chrony');
  await client.executeCommand('sudo systemctl restart chrony');
  converge(clock, 400_000);
  return { router, server, client };
}

const SERVER = 'server 10.0.0.1 iburst minpoll 4 maxpoll 4\nallow\n';

describe('smoothtime', () => {
  it('witness: without smoothtime the daemon answers 505', async () => {
    const { server } = await lab(`${SERVER}makestep 1000 3\n`);
    expect(await server.executeCommand('chronyc smoothing')).toBe('505 Facility not enabled in daemon');
  });

  it('[fails before] chronyc smoothing reports the smoother once the clock has settled', async () => {
    const { server } = await lab(`${SERVER}smoothtime 400 0.001\nmakestep 1000 3\n`);
    expect(await server.executeCommand('chronyc smoothing')).toMatch(/Active +: Yes/);
  });

  it('[fails before] a clock adjustment is smoothed out for the clients and flagged with the SMOO reference', async () => {
    const { router, server, client } = await lab(`${SERVER}smoothtime 400 0.01\nmakestep 1000 3\n`);
    agentOf(router).stepClockBy(300);
    converge(clock, 70_000, 1000);
    const smoothing = await server.executeCommand('chronyc smoothing');
    expect(Number((/Offset +: ([-+\d.]+) seconds/.exec(smoothing) ?? [])[1])).not.toBe(0);
    expect(await client.executeCommand('sudo chronyc ntpdata 10.0.0.2')).toMatch(/Reference ID +: 534D4F4F/);
  });

  it('[fails before] smoothtime reset forgets the smoothed offset', async () => {
    const { router, server } = await lab(`${SERVER}smoothtime 400 0.01\nmakestep 1000 3\n`);
    agentOf(router).stepClockBy(300);
    converge(clock, 70_000, 1000);
    expect(await server.executeCommand('sudo chronyc smoothtime reset')).toBe('200 OK');
    expect(await server.executeCommand('chronyc smoothing')).toMatch(/Offset +: \+0\.000000000 seconds/);
  });

  it('witness: an invalid smoothtime line is refused like any unknown directive', async () => {
    const { server } = await lab(`${SERVER}smoothtime 400\nmakestep 1000 3\n`);
    expect(await server.executeCommand('chronyc smoothing')).toBe('505 Facility not enabled in daemon');
  });
});

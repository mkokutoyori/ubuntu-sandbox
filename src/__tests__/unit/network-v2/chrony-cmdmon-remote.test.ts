/**
 * `chronyc -h <host>` over the simulated network: the request, the reply
 * and the refusals cross the cable as UDP/323 datagrams between two Linux
 * machines (the codec is compared with the real chrony 4.5 in
 * chrony-cmdmon-oracle.test.ts). The daemon decides: it listens only on the
 * addresses `bindcmdaddress` names (127.0.0.1 by default), accepts remote
 * hosts only if `cmdallow` says so, and refuses every request whose
 * permission level is not open, even from the machine itself, because only
 * the Unix socket carries the privileged ones.
 *
 * Measured against the previous client (git worktree of HEAD): 7 of the 10
 * cases fall and 3 pass. The 3 pass either way: the local `chronyc
 * tracking` works (the lab synchronises), `chronyc -h` toward a daemon
 * that is not listening ended in 506 before and after, and the timeout and
 * retries case, because every remote host was refused outright with 506
 * before (so it was never slow).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
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

async function write(pc: LinuxPC, path: string, text: string): Promise<void> {
  await pc.executeCommand(`printf '${text.replace(/\n/g, '\\n')}' | sudo tee ${path}`);
}

async function lab(serverConf: string) {
  const tag = ++serie;
  const router = new CiscoRouter(`R${tag}`);
  const server = new LinuxPC(`S${tag}`);
  const client = new LinuxPC(`C${tag}`);
  const ports = [router.getPort('GigabitEthernet0/0')!, server.getPort('eth0')!];
  new Cable(`a${tag}`).connect(ports[0], ports[1]);
  new Cable(`b${tag}`).connect(server.getPort('eth1')!, client.getPort('eth0')!);
  for (const command of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'ntp master 2', 'end']) {
    await router.executeCommand(command);
  }
  await server.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  await server.executeCommand('ip addr add 10.0.1.1/24 dev eth1');
  await client.executeCommand('ip addr add 10.0.1.2/24 dev eth0');
  await write(server, '/etc/chrony/chrony.conf', serverConf);
  await server.executeCommand('sudo systemctl restart chrony');
  converge(clock, 200_000);
  return { server, client, router };
}

const BASE = 'server 10.0.0.1 iburst minpoll 4 maxpoll 4\nmakestep 1000 3\n';

describe('chronyc -h reaches a daemon through UDP/323', () => {
  it('witness: the local chronyc works and the lab synchronises', async () => {
    const { server } = await lab(BASE);
    expect(await server.executeCommand('chronyc tracking')).toMatch(/Leap status +: Normal/);
  });

  it('[fails before] a remote host reads tracking when the daemon binds the interface and allows the subnet', async () => {
    const { server, client } = await lab(`${BASE}bindcmdaddress 10.0.1.1\ncmdallow 10.0.1.0/24\n`);
    const remote = await client.executeCommand('chronyc -h 10.0.1.1 tracking');
    expect(remote).toMatch(/Reference ID +: [0-9A-F]{8} \(10\.0\.0\.1\)/);
    const local = await server.executeCommand('chronyc tracking');
    expect(remote.match(/Stratum +: \d+/)![0]).toBe(local.match(/Stratum +: \d+/)![0]);
  });

  it('[fails before] sources and sourcestats are read source by source: N_SOURCES then one request per source', async () => {
    const { server, client } = await lab(`${BASE}bindcmdaddress 10.0.1.1\ncmdallow 10.0.1.0/24\n`);
    const before = server.chronyService!.getCommandPackets();
    const sources = await client.executeCommand('chronyc -h 10.0.1.1 sources');
    expect(sources).toMatch(/\^[*+-] 10\.0\.0\.1/);
    expect(server.chronyService!.getCommandPackets() - before).toBe(2);
  });

  it('[fails before] activity, smoothing and manual list are open', async () => {
    const { client } = await lab(`${BASE}bindcmdaddress 10.0.1.1\ncmdallow 10.0.1.0/24\nsmoothtime 400 0.001\n`);
    expect(await client.executeCommand('chronyc -h 10.0.1.1 activity')).toMatch(/1 sources online/);
    expect(await client.executeCommand('chronyc -h 10.0.1.1 smoothing')).toMatch(/Active +: /);
    expect(await client.executeCommand('chronyc -h 10.0.1.1 manual list')).toMatch(/^210 n_samples = 0/);
  });

  it('[fails before] a privileged command from a remote host is refused with 501, even for root', async () => {
    const { client } = await lab(`${BASE}bindcmdaddress 10.0.1.1\ncmdallow 10.0.1.0/24\n`);
    expect(await client.executeCommand('sudo chronyc -h 10.0.1.1 makestep')).toBe('501 Not authorised');
    expect(await client.executeCommand('sudo chronyc -h 10.0.1.1 serverstats')).toBe('501 Not authorised');
  });

  it('[fails before] the machine itself over 127.0.0.1 is localhost but still only reads: the UDP socket is not the Unix socket', async () => {
    const { server } = await lab(BASE);
    expect(await server.executeCommand('sudo chronyc -h 127.0.0.1 tracking')).toMatch(/Leap status +: Normal/);
    expect(await server.executeCommand('sudo chronyc -h 127.0.0.1 makestep')).toBe('501 Not authorised');
  });

  it('witness: without bindcmdaddress the daemon does not listen on the interface and chronyc answers 506', async () => {
    const { client } = await lab(`${BASE}cmdallow 10.0.1.0/24\n`);
    expect(await client.executeCommand('chronyc -h 10.0.1.1 tracking')).toBe('506 Cannot talk to daemon');
  });

  it('[fails before] a daemon that listens but has no cmdallow for the client stays silent: 506 after the retries', async () => {
    const { client } = await lab(`${BASE}bindcmdaddress 10.0.1.1\n`);
    const started = clock.now();
    expect(await client.executeCommand('chronyc -h 10.0.1.1 tracking')).toBe('506 Cannot talk to daemon');
    expect(clock.now() - started).toBeGreaterThanOrEqual(7000);
  });

  it('[fails before] cmdratelimit stops answering a client that asks too fast', async () => {
    const { client } = await lab(`${BASE}bindcmdaddress 10.0.1.1\ncmdallow 10.0.1.0/24\ncmdratelimit interval 6 burst 2 leak 4\n`);
    const answers: string[] = [];
    for (let i = 0; i < 6; i++) answers.push(await client.executeCommand('chronyc -h 10.0.1.1 activity'));
    expect(answers.filter((a) => a.includes('506')).length).toBeGreaterThanOrEqual(1);
    expect(answers[0]).toContain('online');
  });

  it('[fails before] the timeout and retries commands bound how long chronyc insists', async () => {
    const { client } = await lab(`${BASE}bindcmdaddress 10.0.1.1\n`);
    const started = clock.now();
    expect(await client.executeCommand('chronyc -m -h 10.0.1.1 "timeout 200" "retries 0" tracking')).toContain('506');
    expect(clock.now() - started).toBeLessThan(1000);
  });
});

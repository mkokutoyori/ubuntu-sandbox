/**
 * chrony source options evaluated by the daemon: port, presend,
 * auto_offline, copy, asymmetry, filter, maxdelayquant, maxdelay, and the
 * server `port` directive. The sample tests (A: maxdelay, warm-up and
 * server response time; B: maxdelayratio; C: maxdelayquant or
 * maxdelaydevratio; D: synchronisation loop) are the ones ntp_core.c
 * evaluates, reported by `chronyc ntpdata` in its `NTP tests` line.
 *
 * Measured against the previous agent (git worktree of HEAD): 8 of the 12
 * cases fall and 4 pass. The 4 are witnesses: the lab (two hosts or a
 * router and a host) synchronises on the default port; a source without
 * auto_offline stays online; the default maxdelay passes every sample; and
 * the quantile estimator case, a unit test of a class that has no older
 * version (its file was copied into the worktree to run it).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { DelayQuantile } from '@/network/ntp/DelayQuantile';
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

async function chronyPair(serverConf: string, clientConf: string, run = 300_000) {
  const tag = ++serie;
  const server = new LinuxPC(`S${tag}`);
  const client = new LinuxPC(`C${tag}`);
  new Cable(`k${tag}`).connect(server.getPort('eth0')!, client.getPort('eth0')!);
  await server.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
  await client.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  await write(server, '/etc/chrony/chrony.conf', serverConf);
  await write(client, '/etc/chrony/chrony.conf', clientConf);
  await server.executeCommand('sudo systemctl restart chrony');
  await client.executeCommand('sudo systemctl restart chrony');
  converge(clock, run);
  return { server, client };
}

async function routerLab(stratum: number, clientConf: string, run = 300_000) {
  const tag = ++serie;
  const router = new CiscoRouter(`R${tag}`);
  const pc = new LinuxPC(`P${tag}`);
  new Cable(`r${tag}`).connect(router.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  for (const command of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', `ntp master ${stratum}`, 'end']) {
    await router.executeCommand(command);
  }
  await pc.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  await write(pc, '/etc/chrony/chrony.conf', clientConf);
  await pc.executeCommand('sudo systemctl restart chrony');
  converge(clock, run);
  return { router, pc };
}

const SERVER = 'local stratum 5\nallow\n';

describe('port: the NTP server port directive and the per-source port option', () => {
  it('witness: client and server on the default port synchronise', async () => {
    const { client } = await chronyPair(SERVER, 'server 10.0.0.1 iburst\nmakestep 1000 3\n');
    expect(await client.executeCommand('chronyc sources')).toMatch(/\^[*+-] 10\.0\.0\.1/);
  });

  it('[fails before] a server on port 1123 is reached by `server ... port 1123`', async () => {
    const { client } = await chronyPair(`${SERVER}port 1123\n`, 'server 10.0.0.1 port 1123 iburst\nmakestep 1000 3\n');
    expect(await client.executeCommand('chronyc sources')).toMatch(/\^\* 10\.0\.0\.1/);
    expect(await client.executeCommand('sudo chronyc ntpdata 10.0.0.1')).toMatch(/Remote port +: 1123/);
  });

  it('[fails before] the same server is not answering on the default port', async () => {
    const { client } = await chronyPair(`${SERVER}port 1123\n`, 'server 10.0.0.1 iburst\nmakestep 1000 3\n');
    expect(await client.executeCommand('chronyc sources')).toMatch(/\^\? 10\.0\.0\.1 +0 /);
  });
});

describe('presend, auto_offline, copy', () => {
  it('[fails before] presend sends a warm-up request before every request and ignores its reply', async () => {
    const plain = await routerLab(2, 'server 10.0.0.1 minpoll 4 maxpoll 4\nmakestep 1000 3\n', 0);
    const warm = await routerLab(2, 'server 10.0.0.1 minpoll 4 maxpoll 4 presend 4\nmakestep 1000 3\n', 0);
    converge(clock, 200_000);
    const sent = async (pc: LinuxPC): Promise<number> =>
      Number((/Total TX +: (\d+)/.exec(await pc.executeCommand('sudo chronyc ntpdata 10.0.0.1')) ?? [])[1]);
    expect(await sent(warm.pc)).toBeGreaterThan(1.5 * await sent(plain.pc));
  });

  it('[fails before] auto_offline takes a source offline when it cannot even be sent to', async () => {
    const { client } = await chronyPair(SERVER, 'server 192.0.2.99 auto_offline minpoll 4\nmakestep 1000 3\n', 120_000);
    expect(await client.executeCommand('sudo chronyc activity')).toMatch(/1 sources offline/);
  });

  it('witness: without auto_offline an unreachable source stays online', async () => {
    const { client } = await chronyPair(SERVER, 'server 192.0.2.99 minpoll 4\nmakestep 1000 3\n', 120_000);
    expect(await client.executeCommand('sudo chronyc activity')).not.toMatch(/1 sources offline/);
  });

  it('[fails before] copy makes the client claim the stratum of its server', async () => {
    const copied = await routerLab(3, 'server 10.0.0.1 copy iburst\nmakestep 1000 3\n');
    const plain = await routerLab(3, 'server 10.0.0.1 iburst\nmakestep 1000 3\n');
    expect(await plain.pc.executeCommand('chronyc tracking')).toMatch(/Stratum +: 4/);
    expect(await copied.pc.executeCommand('chronyc tracking')).toMatch(/Stratum +: 3/);
  });
});

describe('asymmetry, filter, maxdelay, maxdelayquant', () => {
  it('[fails before] a fixed asymmetry is reported by ntpdata', async () => {
    const { pc } = await routerLab(2, 'server 10.0.0.1 asymmetry 0.3 iburst\nmakestep 1000 3\n');
    expect(await pc.executeCommand('sudo chronyc ntpdata 10.0.0.1')).toMatch(/Jitter asymmetry: \+0\.30/);
  });

  it('[fails before] filter 4 hands the regression one sample for every four replies', async () => {
    const plain = await routerLab(2, 'server 10.0.0.1 minpoll 4 maxpoll 4\nmakestep 1000 3\n', 0);
    const filtered = await routerLab(2, 'server 10.0.0.1 minpoll 4 maxpoll 4 filter 4\nmakestep 1000 3\n', 0);
    converge(clock, 400_000);
    const samples = async (pc: LinuxPC): Promise<number> =>
      Number((/^10\.0\.0\.1 +(\d+)/m.exec(await pc.executeCommand('chronyc sourcestats')) ?? [])[1]);
    expect(await samples(plain.pc)).toBeGreaterThanOrEqual(8);
    expect(await samples(filtered.pc)).toBeLessThanOrEqual(Math.ceil(await samples(plain.pc) / 3));
  });

  it('witness: the default maxdelay of 3 seconds passes every sample', async () => {
    const { pc } = await routerLab(2, 'server 10.0.0.1 iburst\nmakestep 1000 3\n');
    expect(await pc.executeCommand('sudo chronyc ntpdata 10.0.0.1')).toMatch(/NTP tests +: 111 111 1111/);
  });

  it('[fails before] a maxdelay below the path delay fails test A on every sample', async () => {
    const { pc } = await routerLab(2, 'server 10.0.0.1 maxdelay 0.0000001 iburst\nmakestep 1000 3\n');
    expect(await pc.executeCommand('sudo chronyc ntpdata 10.0.0.1')).toMatch(/NTP tests +: 111 111 0/);
    expect(await pc.executeCommand('chronyc sourcestats')).toMatch(/^10\.0\.0\.1 +0 /m);
  });

  it('witness: maxdelayquant tracks a quantile of the delay by stochastic approximation', () => {
    const quantile = DelayQuantile.fromFraction(0.5, 1e-3);
    let state = 12345;
    const next = (): number => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
    for (let i = 0; i < 20000; i++) quantile.accumulate(next());
    expect(quantile.quantile()).toBeGreaterThan(0.4);
    expect(quantile.quantile()).toBeLessThan(0.6);
  });
});

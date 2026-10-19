/**
 * chronyd source selection (sources.c SRC_SelectSource / combine_sources):
 * trust, require, prefer, noselect, minsources, maxdistance, maxjitter,
 * reselect, the scoring that keeps the selected source, orphan mode,
 * local distance, maxupdateskew and maxchange. The status characters and
 * the sources/selectdata states are the ones get_status_char and
 * SRC_ReportSource produce.
 *
 * Measured against the previous agent (git worktree of HEAD): 12 of the 20
 * cases fall and 8 pass. The 8 are the witnesses: the lab (three routers, a
 * switch, a chrony host) synchronises; a lone wrong server was already a
 * falseticker (the intersection algorithm existed); without `trust` the two
 * agreeing wrong servers already won; `minsources 2` with two servers;
 * `noselect` already excluded a source; the default maxupdateskew; the same
 * offset without maxchange; the default local distance.
 *
 * The two `sign guard` cases pass against HEAD and fell against the first
 * version of the port, which fed the combined offset to the discipline in
 * chrony's own sign (local minus remote) instead of the agent's (remote
 * minus local): with a real offset the clock moved away from the servers
 * (10000 ms gap after a 5 s step, 800 ms after a 200 ms slew). The earlier
 * labs had no offset to expose it.
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

interface ServerSpec { readonly stratum: number; readonly offsetMs: number }

const agentOf = (device: unknown): NtpAgent => (device as { getNtpAgent(): NtpAgent }).getNtpAgent();

async function write(pc: LinuxPC, path: string, text: string): Promise<void> {
  await pc.executeCommand(`printf '${text.replace(/\n/g, '\\n')}' | sudo tee ${path}`);
}

async function lab(servers: readonly ServerSpec[], conf: (ips: string[]) => string, run = 300_000) {
  const tag = ++serie;
  const sw = new CiscoSwitch('switch-cisco', `W${tag}`, 24, 0, 0);
  const pc = new LinuxPC(`P${tag}`);
  new Cable(`p${tag}`).connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  const ips: string[] = [];
  const routers: CiscoRouter[] = [];
  for (let i = 0; i < servers.length; i++) {
    const router = new CiscoRouter(`R${tag}-${i}`);
    new Cable(`r${tag}-${i}`).connect(router.getPort('GigabitEthernet0/0')!, sw.getPort(`FastEthernet0/${i + 2}`)!);
    const ip = `10.0.0.${i + 1}`;
    for (const command of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      `ip address ${ip} 255.255.255.0`, 'no shutdown', 'exit', `ntp master ${servers[i].stratum}`, 'end']) {
      await router.executeCommand(command);
    }
    if (servers[i].offsetMs !== 0) agentOf(router).stepClockBy(servers[i].offsetMs);
    ips.push(ip);
    routers.push(router);
  }
  await pc.executeCommand('ip addr add 10.0.0.100/24 dev eth0');
  await write(pc, '/etc/chrony/chrony.conf', conf(ips));
  await pc.executeCommand('sudo systemctl restart chrony');
  converge(clock, run);
  return { pc, routers, ips, sw };
}

const stateOf = async (pc: LinuxPC, ip: string): Promise<string> => {
  const text = await pc.executeCommand('sudo chronyc selectdata');
  const line = text.split('\n').find((l) => l.includes(` ${ip} `));
  return line === undefined ? '' : line.trim().split(/\s+/)[0];
};

const servers3 = [{ stratum: 2, offsetMs: 0 }, { stratum: 2, offsetMs: 0 }, { stratum: 2, offsetMs: 0 }];
const servers = (ips: string[], options: readonly string[] = []): string =>
  `${ips.map((ip, i) => `server ${ip} iburst ${options[i] ?? ''}`).join('\n')}\nmakestep 1000 3\n`;

describe('selection among agreeing and disagreeing sources', () => {
  it('witness: synchronises on three agreeing servers with one selected', async () => {
    const { pc, ips } = await lab(servers3, (i) => servers(i));
    const states = await Promise.all(ips.map((ip) => stateOf(pc, ip)));
    expect(states.filter((s) => s === '*')).toHaveLength(1);
    expect(states.filter((s) => s === '+').length).toBeGreaterThanOrEqual(1);
    expect(await pc.executeCommand('chronyc tracking')).toMatch(/Leap status +: Normal/);
  });

  it('witness: a lone wrong server is a falseticker', async () => {
    const { pc, ips } = await lab(
      [servers3[0], servers3[1], { stratum: 2, offsetMs: 5000 }], (i) => servers(i));
    expect(await stateOf(pc, ips[2])).toBe('x');
    expect(await pc.executeCommand('sudo chronyc sources')).toMatch(/\^x 10\.0\.0\.3/);
  });

  it('[fails before] trust lets one trusted server outvote two agreeing wrong ones', async () => {
    const wrong = { stratum: 2, offsetMs: 5000 };
    const { pc, ips } = await lab([servers3[0], wrong, wrong], (i) => servers(i, ['trust']));
    expect(await stateOf(pc, ips[0])).toBe('*');
    expect(await stateOf(pc, ips[1])).toBe('x');
    expect(await stateOf(pc, ips[2])).toBe('x');
  });

  it('witness: without trust the two agreeing wrong servers win', async () => {
    const wrong = { stratum: 2, offsetMs: 5000 };
    const { pc, ips } = await lab([servers3[0], wrong, wrong], (i) => servers(i));
    expect(await stateOf(pc, ips[0])).toBe('x');
  });

  it('[fails before] require on a falseticker withholds every update: W for the others', async () => {
    const { pc, ips } = await lab(
      [servers3[0], servers3[1], { stratum: 2, offsetMs: 5000 }], (i) => servers(i, ['', '', 'require']));
    expect(await stateOf(pc, ips[0])).toBe('W');
    expect(await pc.executeCommand('chronyc tracking')).toMatch(/Reference ID +: 00000000/);
  });

  it('[fails before] prefer restricts the selection to preferred sources: the rest are P', async () => {
    const { pc, ips } = await lab(servers3, (i) => servers(i, ['', 'prefer', '']));
    expect(await stateOf(pc, ips[1])).toBe('*');
    expect(await stateOf(pc, ips[0])).toBe('P');
    expect(await stateOf(pc, ips[2])).toBe('P');
  });

  it('[fails before] minsources 2 with a single server never synchronises', async () => {
    const { pc, ips } = await lab([servers3[0]], (i) => `${servers(i)}minsources 2\n`);
    expect(await stateOf(pc, ips[0])).toBe('W');
    expect(await pc.executeCommand('chronyc tracking')).toMatch(/Reference ID +: 00000000/);
  });

  it('witness: minsources 2 with two servers synchronises', async () => {
    const { pc, ips } = await lab([servers3[0], servers3[1]], (i) => `${servers(i)}minsources 2\n`);
    expect(await stateOf(pc, ips[0]) + await stateOf(pc, ips[1])).toMatch(/\*\+|\+\*/);
  });

  it('[fails before] maxdistance below the root distance marks every server d', async () => {
    const { pc, ips } = await lab(servers3, (i) => `${servers(i)}maxdistance 0.0000001\n`);
    expect(await stateOf(pc, ips[0])).toBe('d');
    expect(await pc.executeCommand('chronyc tracking')).toMatch(/Reference ID +: 00000000/);
  });

  it('[fails before] maxjitter below the measured deviation marks the server ~', async () => {
    const { pc, ips } = await lab([servers3[0]], (i) => `${servers(i)}maxjitter 0\n`);
    expect(['~', 'M']).toContain(await stateOf(pc, ips[0]));
    expect(await stateOf(pc, ips[0])).toBe('~');
  });

  it('noselect keeps the server out of the selection and selectdata says N', async () => {
    const { pc, ips } = await lab(servers3, (i) => servers(i, ['noselect', '', '']));
    expect(await stateOf(pc, ips[0])).toBe('N');
  });

  it('[fails before] chronyc reselect forgets the selected source until the next sample (U)', async () => {
    const { pc, ips } = await lab(servers3, (i) => servers(i));
    expect(await pc.executeCommand('sudo chronyc reselect')).toBe('200 OK');
    const states = await Promise.all(ips.map((ip) => stateOf(pc, ip)));
    expect(states).toContain('U');
    converge(clock, 120_000);
    const after = await Promise.all(ips.map((ip) => stateOf(pc, ip)));
    expect(after.filter((s) => s === '*')).toHaveLength(1);
  });

  it('[fails before] selectopts +noselect only takes effect at the next sample', async () => {
    const { pc, ips } = await lab(servers3, (i) => servers(i));
    const selected = (await Promise.all(ips.map(async (ip) => ((await stateOf(pc, ip)) === '*' ? ip : '')))).find(Boolean)!;
    expect(await pc.executeCommand(`sudo chronyc selectopts ${selected} +noselect`)).toBe('200 OK');
    expect(await stateOf(pc, selected)).toBe('*');
    converge(clock, 120_000);
    expect(await stateOf(pc, selected)).toBe('N');
  });
});

describe('the combined offset moves the clock towards the servers', () => {
  it('sign guard: a client 5 s behind its three servers is stepped forward, not backward', async () => {
    const ahead = { stratum: 2, offsetMs: 5000 };
    const { pc, routers } = await lab([ahead, ahead, ahead], (i) => `${servers(i)}`.replace('makestep 1000 3', 'makestep 1 3'));
    const gap = Math.abs(agentOf(pc).now() - agentOf(routers[0]).now());
    expect(gap).toBeLessThan(50);
  });

  it('sign guard: a client 200 ms ahead of its servers slews back, not further away', async () => {
    const behind = { stratum: 2, offsetMs: -200 };
    const { pc, routers } = await lab([behind, behind, behind], (i) => `${servers(i)}`.replace('makestep 1000 3', ''), 600_000);
    const gap = Math.abs(agentOf(pc).now() - agentOf(routers[0]).now());
    expect(gap).toBeLessThan(200);
  });
});

describe('maxupdateskew, maxchange and local distance', () => {
  it('[fails before] a tiny maxupdateskew refuses to learn the frequency: the skew stays at its initial 1', async () => {
    const { pc } = await lab([servers3[0]], (i) => `${servers(i)}maxupdateskew 0.0000001\n`);
    expect(await pc.executeCommand('chronyc tracking')).toMatch(/Skew +: 1000000\.000 ppm/);
  });

  it('witness: the default maxupdateskew learns a skew far below 1', async () => {
    const { pc } = await lab([servers3[0]], (i) => servers(i));
    const skew = Number((/Skew +: ([\d.]+) ppm/.exec(await pc.executeCommand('chronyc tracking')) ?? [])[1]);
    expect(skew).toBeLessThan(1000000);
  });

  it('[fails before] chronyc maxupdateskew changes the limit at run time', async () => {
    const { pc } = await lab([servers3[0]], (i) => servers(i));
    expect(await pc.executeCommand('sudo chronyc maxupdateskew 5')).toBe('200 OK');
    expect(agentOf(pc).getReference().maxUpdateSkewPpm()).toBe(5);
  });

  it('[fails before] maxchange exits chronyd when an adjustment exceeds the limit', async () => {
    const { pc } = await lab(
      [{ stratum: 2, offsetMs: 5000 }], (i) => `server ${i[0]} iburst\nmaxchange 1 0 0\n`);
    expect(await pc.executeCommand('systemctl is-active chrony')).toMatch(/inactive|failed/);
  });

  it('witness: the same offset without maxchange is stepped and chronyd keeps running', async () => {
    const { pc } = await lab(
      [{ stratum: 2, offsetMs: 5000 }], (i) => `server ${i[0]} iburst\nmakestep 1 3\n`);
    expect(await pc.executeCommand('systemctl is-active chrony')).toMatch(/active/);
  });

  it('[fails before] local distance 0 serves the local reference even while synchronised', async () => {
    const { pc } = await lab(
      [servers3[0]], (i) => `${servers(i)}local stratum 7 distance 0.0000001\nallow\n`);
    const header = (agentOf(pc) as unknown as { systemHeader(): { stratum: number; refIdentifier: string } }).systemHeader();
    expect(header.stratum).toBe(7);
    expect(header.refIdentifier).toBe('127.127.1.1');
  });

  it('witness: the default local distance of 1 second keeps serving the real stratum', async () => {
    const { pc } = await lab([servers3[0]], (i) => `${servers(i)}local stratum 7\nallow\n`);
    const header = (agentOf(pc) as unknown as { systemHeader(): { stratum: number } }).systemHeader();
    expect(header.stratum).toBe(3);
  });
});

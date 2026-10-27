/*
 * Probe - the resource-usage object of impstats (plugins/impstats/impstats.c) reports the getrusage(RUSAGE_SELF) of rsyslogd:
 * utime stime maxrss minflt majflt inblock oublock nvcsw nivcsw openfiles.  The simulator accounts what it can derive from events the
 * daemon really causes: oublock counts 512-byte sectors of page-cache pages the daemon dirtied (one 4 KiB page counts 8 sectors the
 * first time it is dirtied, and again once the kernel has written it back after dirty_expire_centisecs = 30 s); inblock counts
 * the sectors read from a cold disk (a file nobody wrote or read since boot, fetched with the 128 KiB read-ahead window, then
 * served from the page cache; a file another process wrote is already cached; io-page-cache.test.ts checks the cache directly); nvcsw counts the times the daemon was woken (a
 * datagram, a TCP segment or connection, a timer, a read that had to wait for the disk); maxrss is the peak of the resident size
 * and minflt the pages of that peak.  stime, majflt and nivcsw are 0 by construction: the simulator has no kernel mode, demand
 * paging or CPU contention.
 * Measured before the accounting (git stash push -- src/network): 4 of the 8 Linux cases fall (oublock, both voluntary-switch cases,
 * the peak of the resident size) - the object carried the current resident size as maxrss and 0 in every other field.  The 4 that
 * pass either way are the WITNESS (the object exists with the open files), the restart case (inblock 0 is also what the old zero
 * said: non-regression), the reset case and the by-construction zeros.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const CONFIG = 'module(load="impstats" interval="60" log.syslog="off" log.file="/var/log/stats.log")\nmodule(load="imudp")\ninput(type="imudp" port="514")\n*.* /var/log/probe.log';

async function lab(): Promise<{ server: LinuxServer; client: LinuxPC; executor: LinuxCommandExecutor }> {
  const server = new LinuxServer('linux-server', 'server1', 0, 0);
  const client = new LinuxPC('linux-pc', 'client1', 0, 0);
  server.powerOn();
  client.powerOn();
  new Cable('wire').connect(server.getPort('eth0')!, client.getPort('eth0')!);
  await server.executeCommand('ip addr add 192.168.50.1/24 dev eth0');
  await server.executeCommand('ip link set eth0 up');
  await client.executeCommand('ip addr add 192.168.50.2/24 dev eth0');
  await client.executeCommand('ip link set eth0 up');
  await server.executeCommand(`printf '${CONFIG.replace(/'/g, "'\\''")}\\n' > /etc/rsyslog.d/40-test.conf`);
  await server.executeCommand('systemctl restart rsyslog');
  return { server, client, executor: (server as unknown as { executor: LinuxCommandExecutor }).executor };
}

type Usage = Record<'utime' | 'stime' | 'maxrss' | 'minflt' | 'majflt' | 'inblock' | 'oublock' | 'nvcsw' | 'nivcsw' | 'openfiles', number>;

async function usage(server: LinuxServer): Promise<Usage> {
  server.advanceTime(60_000);
  const text = await server.executeCommand('grep "resource-usage" /var/log/stats.log | tail -1');
  const fields = Object.fromEntries([...text.matchAll(/(\w+)=(\d+)/g)].map((match) => [match[1], Number(match[2])]));
  return fields as unknown as Usage;
}

const datagram = (client: LinuxPC, text: string): Promise<string> => client.executeCommand(`echo "${text}" | nc -u -w1 192.168.50.1 514`);

describe('resource-usage of impstats', () => {
  it('witness: the object is published with the open file count', async () => {
    const { server } = await lab();
    const fields = await usage(server);
    expect(fields.openfiles).toBeGreaterThan(0);
  });

  it('reads the configuration from the page cache when the daemon restarts on a machine that already read it', async () => {
    const { server } = await lab();
    const fields = await usage(server);
    expect(fields.inblock).toBe(0);
  });

  it('counts a page of sectors once however many lines go to it in an interval, and again in the next interval', async () => {
    const { server, client } = await lab();
    await usage(server);
    const quiet = await usage(server);
    const afterQuiet = await usage(server);
    for (let count = 0; count < 5; count++) await datagram(client, `<13>Oct 19 12:00:0${count} client1 probe: line ${count}`);
    const burst = await usage(server);
    await datagram(client, '<13>Oct 19 12:01:00 client1 probe: single');
    const single = await usage(server);
    await datagram(client, '<13>Oct 19 12:02:00 client1 probe: again');
    const again = await usage(server);
    const quietDelta = afterQuiet.oublock - quiet.oublock;
    expect(quietDelta % 8).toBe(0);
    expect(quietDelta).toBeGreaterThanOrEqual(8);
    expect(quietDelta).toBeLessThanOrEqual(16);
    expect(burst.oublock - afterQuiet.oublock).toBeGreaterThan(quietDelta);
    expect(single.oublock - burst.oublock).toBeGreaterThan(quietDelta);
    expect(Math.abs(again.oublock - single.oublock - (single.oublock - burst.oublock))).toBeLessThanOrEqual(8);
  });

  it('counts a voluntary switch for every datagram that wakes the daemon', async () => {
    const { server, client } = await lab();
    const base = await usage(server);
    for (let count = 0; count < 4; count++) await datagram(client, `<13>Oct 19 12:00:0${count} client1 probe: wake ${count}`);
    const after = await usage(server);
    expect(after.nvcsw - base.nvcsw).toBeGreaterThanOrEqual(4);
  });

  it('counts a voluntary switch for each timer that fires', async () => {
    const { server } = await lab();
    const base = await usage(server);
    server.advanceTime(10 * 60_000);
    const after = await usage(server);
    expect(after.nvcsw).toBeGreaterThan(base.nvcsw);
  });

  it('keeps the peak of the resident size, not its current value, and derives the minor faults from it', async () => {
    const { server, executor } = await lab();
    const record = executor.processMgr.list().find((entry) => entry.comm === 'rsyslogd') as unknown as { rss: number };
    record.rss = 40_000;
    const high = await usage(server);
    record.rss = 10_000;
    const low = await usage(server);
    expect(high.maxrss).toBe(40_000);
    expect(low.maxrss).toBe(40_000);
    expect(low.minflt).toBe(10_000);
  });

  it('resets the counters when the daemon is a new process', async () => {
    const { server } = await lab();
    await usage(server);
    await server.executeCommand('systemctl restart rsyslog');
    const after = await usage(server);
    expect(after.nvcsw).toBeLessThan(10);
  });

  it('reports stime, majflt and nivcsw as zero: the model has no kernel mode, demand paging or CPU contention', async () => {
    const { server, client } = await lab();
    await datagram(client, '<13>Oct 19 12:00:00 client1 probe: x');
    const fields = await usage(server);
    expect([fields.stime, fields.majflt, fields.nivcsw]).toEqual([0, 0, 0]);
  });
});
